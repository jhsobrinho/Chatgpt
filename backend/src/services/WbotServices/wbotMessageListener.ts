import { join } from "path";
import { promisify } from "util";
import { writeFile } from "fs";
import { head, isNil } from "lodash";
// import * as Sentry from "@sentry/node";

import {
  Contact as WbotContact,
  Message as WbotMessage,
  MessageAck,
  Client
} from "whatsapp-web.js";

import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Queue from "../../models/Queue";

import { getIO } from "../../libs/socket";
import CreateMessageService from "../MessageServices/CreateMessageService";
import { logger } from "../../utils/logger";
import CreateOrUpdateContactService from "../ContactServices/CreateOrUpdateContactService";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import { debounce } from "../../helpers/Debounce";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import QueueOption from "../../models/QueueOption";

interface Session extends Client {
  id?: number;
}

const writeFileAsync = promisify(writeFile);

const verifyContact = async (msgContact: WbotContact): Promise<Contact> => {
  const profilePicUrl = await msgContact.getProfilePicUrl();

  const contactData = {
    name: msgContact.name || msgContact.pushname || msgContact.id.user,
    number: msgContact.id.user,
    profilePicUrl,
    isGroup: msgContact.isGroup
  };

  const contact = CreateOrUpdateContactService(contactData);

  return contact;
};

const verifyQuotedMessage = async (
  msg: WbotMessage
): Promise<Message | null> => {
  if (!msg.hasQuotedMsg) return null;

  const wbotQuotedMsg = await msg.getQuotedMessage();

  const quotedMsg = await Message.findOne({
    where: { id: wbotQuotedMsg.id.id }
  });

  if (!quotedMsg) return null;

  return quotedMsg;
};

const verifyMediaMessage = async (
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
): Promise<Message> => {
  const quotedMsg = await verifyQuotedMessage(msg);

  const media = await msg.downloadMedia();

  if (!media) {
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  if (!media.filename) {
    const ext = media.mimetype.split("/")[1].split(";")[0];
    media.filename = `${new Date().getTime()}.${ext}`;
  }

  try {
    await writeFileAsync(
      join(__dirname, "..", "..", "..", "public", media.filename),
      media.data,
      "base64"
    );
  } catch (err: any) {
    // Sentry.captureException(err);
    logger.error(err);
  }

  const messageData = {
    id: msg.id.id,
    ticketId: ticket.id,
    contactId: msg.fromMe ? undefined : contact.id,
    body: msg.body || media.filename,
    fromMe: msg.fromMe,
    read: msg.fromMe,
    mediaUrl: media.filename,
    mediaType: media.mimetype.split("/")[0],
    quotedMsgId: quotedMsg?.id
  };

  await ticket.update({ lastMessage: msg.body || media.filename });
  const newMessage = await CreateMessageService({ messageData });

  return newMessage;
};

export const verifyMessage = async (
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  const quotedMsg = await verifyQuotedMessage(msg);

  const messageData = {
    id: msg.id.id,
    ticketId: ticket.id,
    contactId: msg.fromMe ? undefined : contact.id,
    body: msg.body,
    fromMe: msg.fromMe,
    mediaType: msg.type,
    read: msg.fromMe,
    quotedMsgId: quotedMsg?.id
  };

  await ticket.update({ lastMessage: msg.body });
  await CreateMessageService({ messageData });
};

const verifyQueue = async (
  wbot: Session,
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  const { queues, greetingMessage } = await ShowWhatsAppService(wbot.id!);

  if (queues.length === 1) {
    const firstQueue = head(queues);
    let chatbot = false
    if (firstQueue?.options) {
      chatbot = firstQueue.options.length > 0
    }
    await UpdateTicketService({
      ticketData: { queueId: firstQueue?.id, chatbot },
      ticketId: ticket.id
    });

    return;
  }

  const selectedOption = msg.body;

  const choosenQueue = queues[+selectedOption - 1];

  if (choosenQueue) {
    let chatbot = false
    if (choosenQueue?.options) {
      chatbot = choosenQueue.options.length > 0
    }

    await UpdateTicketService({
      ticketData: { queueId: choosenQueue.id, chatbot },
      ticketId: ticket.id
    });

    if (choosenQueue.options.length == 0) {
      const body = `\u200e${choosenQueue.greetingMessage}`;

      const sentMessage = await wbot.sendMessage(`${contact.number}@c.us`, body);
      await verifyMessage(sentMessage, ticket, contact);
    }
  } else {
    let options = "";

    queues.forEach((queue, index) => {
      options += `*${index + 1}* - ${queue.name}\n`;
    });

    const body = `\u200e${greetingMessage}\n${options}`;

    const debouncedSentMessage = debounce(
      async () => {
        const sentMessage = await wbot.sendMessage(
          `${contact.number}@c.us`,
          body
        );
        verifyMessage(sentMessage, ticket, contact);
      },
      3000,
      ticket.id
    );

    debouncedSentMessage();
  }
};

const isValidMsg = (msg: WbotMessage): boolean => {
  if (msg.from === "status@broadcast") return false;
  if (
    msg.type === "chat" ||
    msg.type === "audio" ||
    msg.type === "ptt" ||
    msg.type === "video" ||
    msg.type === "image" ||
    msg.type === "document" ||
    msg.type === "vcard" ||
    msg.type === "sticker"
  )
    return true;
  return false;
};

const handleChartbot = async (ticket: Ticket, msg: WbotMessage, wbot: Session, dontReadTheFirstQuestion: boolean = false) => {
  const queue = await Queue.findByPk(ticket.queueId, {
    include: [{
      model: QueueOption,
      as: 'options',
      where: { parentId: null },
      order: [
        ['option', 'ASC'],
        ['createdAt', 'ASC']
      ]
    }]
  });

  if (msg.body == '00') {// voltar para o menu inicial
    await ticket.update({ queueOptionId: null, chatbot: false, queueId: null })
    await verifyQueue(wbot, msg, ticket, ticket.contact);
    return null
  }

  if (!isNil(queue) && !isNil(ticket.queueOptionId) && msg.body == '#') {// falar com atendente
    await ticket.update({ queueOptionId: null, chatbot: false })
    const sentMessage = await wbot.sendMessage(
      `${ticket.contact.number}@c.us`,
      '\u200eAguarde, você será atendido em instantes.'
    );
    verifyMessage(sentMessage, ticket, ticket.contact);
    return;
  } else if (!isNil(queue) && !isNil(ticket.queueOptionId) && msg.body == '0') {// voltar para o menu anterior
    const option = await QueueOption.findByPk(ticket.queueOptionId);
    await ticket.update({ queueOptionId: option?.parentId })
  } else if (!isNil(queue) && !isNil(ticket.queueOptionId)) {// escolheu uma opção
    const count = await QueueOption.count({ where: { parentId: ticket.queueOptionId } });
    let option: any = {};
    if (count == 1) {
      option = await QueueOption.findOne({ where: { parentId: ticket.queueOptionId } })
    } else {
      option = await QueueOption.findOne({ where: { option: msg.body, parentId: ticket.queueOptionId } })
    }
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
    }
  } else if (!isNil(queue) && isNil(ticket.queueOptionId) && !dontReadTheFirstQuestion) {// não linha a primeira pergunta
    const option = queue?.options.find(o => o.option == msg.body);
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
    }
  }

  await ticket.reload();

  if (!isNil(queue) && isNil(ticket.queueOptionId)) {
    let body = ``;
    let options = '';
    const queueOptions = await QueueOption.findAll({
      where: { queueId: ticket.queueId, parentId: null },
      order: [
        ['option', 'ASC'],
        ['createdAt', 'ASC']
      ]
    });

    if (queue.greetingMessage) {
      body = `${queue.greetingMessage}\n\n`;
    }

    queueOptions.forEach((option, i) => {
      if (queueOptions.length - 1 > i) {
        options += `*${option.option}* - ${option.title}\n`;
      } else {
        options += `*${option.option}* - ${option.title}`;
      }
    });

    if (options !== '') {
      body += options;
    }

    body += '\n\n*00* - *Menu inicial*';

    const debouncedSentMessage = debounce(
      async () => {
        const sentMessage = await wbot.sendMessage(
          `${ticket.contact.number}@c.us`,
          body
        );
        verifyMessage(sentMessage, ticket, ticket.contact);
      },
      3000,
      ticket.id
    );

    debouncedSentMessage();
  } else if (!isNil(queue) && !isNil(ticket.queueOptionId)) {
    const currentOption = await QueueOption.findByPk(ticket.queueOptionId);
    const queueOptions = await QueueOption.findAll({
      where: { parentId: ticket.queueOptionId },
      order: [
        ['option', 'ASC'],
        ['createdAt', 'ASC']
      ]
    });
    let body = '';
    let options = '';
    let initialMessage = '';
    let aditionalOptions = '\n';

    if (queueOptions.length > 1) {
      if (!isNil(currentOption?.message) && currentOption?.message !== '') {
        initialMessage = `${currentOption?.message}\n\n`;
        body += initialMessage;
      }

      if (queueOptions.length == 0) {
        aditionalOptions = '*#* - *Falar com o atendente*\n';
      }

      queueOptions.forEach((option) => {
        options += `*${option.option}* - ${option.title}\n`;
      });

      if (options !== '') {
        body += options;
      }

      aditionalOptions += '*0* - *Voltar*\n';
      aditionalOptions += '*00* - *Menu inicial*';

      body += aditionalOptions;
    } else {
      const firstOption = head(queueOptions);
      if (firstOption) {
        body = `${firstOption?.title}`;
        if (firstOption?.message) {
          body += `\n\n${firstOption.message}`;
        }
      } else {
        body = `*#* - *Falar com o atendente*\n\n`;
        body += `*0* - *Voltar*\n`;
        body += `*00* - *Menu inicial*`;
      }
    }

    const debouncedSentMessage = debounce(
      async () => {
        const sentMessage = await wbot.sendMessage(
          `${ticket.contact.number}@c.us`,
          body
        );
        verifyMessage(sentMessage, ticket, ticket.contact);
      },
      3000,
      ticket.id
    );

    debouncedSentMessage();
  }
}

const handleMessage = async (
  msg: WbotMessage,
  wbot: Session
): Promise<void> => {
  if (!isValidMsg(msg)) {
    return;
  }

  try {
    let msgContact: WbotContact;
    let groupContact: Contact | undefined;

    if (msg.fromMe) {
      // messages sent automatically by wbot have a special character in front of it
      // if so, this message was already been stored in database;
      if (/\u200e/.test(msg.body[0])) return;

      // media messages sent from me from cell phone, first comes with "hasMedia = false" and type = "image/ptt/etc"
      // in this case, return and let this message be handled by "media_uploaded" event, when it will have "hasMedia = true"

      if (!msg.hasMedia && msg.type !== "chat" && msg.type !== "vcard") return;

      msgContact = await wbot.getContactById(msg.to);
    } else {
      msgContact = await msg.getContact();
    }

    const chat = await msg.getChat();

    if (chat.isGroup) {
      let msgGroupContact;

      if (msg.fromMe) {
        msgGroupContact = await wbot.getContactById(msg.to);
      } else {
        msgGroupContact = await wbot.getContactById(msg.from);
      }

      groupContact = await verifyContact(msgGroupContact);
    }

    const unreadMessages = msg.fromMe ? 0 : chat.unreadCount;

    const contact = await verifyContact(msgContact);
    const ticket = await FindOrCreateTicketService(
      contact,
      wbot.id!,
      unreadMessages,
      groupContact
    );

    if (msg.hasMedia) {
      await verifyMediaMessage(msg, ticket, contact);
    } else {
      await verifyMessage(msg, ticket, contact);
    }

    const whatsapp = await ShowWhatsAppService(wbot.id!);

    const dontReadTheFirstQuestion = ticket.queue === null;

    if (
      !ticket.queue &&
      !chat.isGroup &&
      !msg.fromMe &&
      !ticket.userId &&
      whatsapp.queues.length >= 1
    ) {
      await verifyQueue(wbot, msg, ticket, contact);
    }

    await ticket.reload();
    if (whatsapp.queues.length == 1 && ticket.queue) {
      if (ticket.chatbot && !msg.fromMe) {
        await handleChartbot(ticket, msg, wbot);
      }
    }
    if (whatsapp.queues.length > 1 && ticket.queue) {
      if (ticket.chatbot && !msg.fromMe) {
        await handleChartbot(ticket, msg, wbot, dontReadTheFirstQuestion);
      }
    }
  } catch (err) {
    // Sentry.captureException(err);
    logger.error(`Error handling whatsapp message: Err: ${err}`);
  }
};

const handleMsgAck = async (msg: WbotMessage, ack: MessageAck) => {
  await new Promise(r => setTimeout(r, 500));

  const io = getIO();

  try {
    const messageToUpdate = await Message.findByPk(msg.id.id, {
      include: [
        "contact",
        {
          model: Message,
          as: "quotedMsg",
          include: ["contact"]
        }
      ]
    });
    if (!messageToUpdate) {
      return;
    }
    await messageToUpdate.update({ ack });

    io.to(messageToUpdate.ticketId.toString()).emit("appMessage", {
      action: "update",
      message: messageToUpdate
    });
  } catch (err) {
    // Sentry.captureException(err);
    logger.error(`Error handling message ack. Err: ${err}`);
  }
};

const wbotMessageListener = (wbot: Session): void => {
  wbot.on("message_create", async msg => {
    handleMessage(msg, wbot);
  });

  wbot.on("media_uploaded", async msg => {
    handleMessage(msg, wbot);
  });

  wbot.on("message_ack", async (msg, ack) => {
    handleMsgAck(msg, ack);
  });
};

export { wbotMessageListener, handleMessage };
