import { Request, Response } from "express";
import AppError from "../errors/AppError";

import SetTicketMessagesAsRead from "../helpers/SetTicketMessagesAsRead";
import { getIO } from "../libs/socket";

import Message from "../models/Message";
import Ticket from "../models/Ticket";

import ListMessagesService from "../services/MessageServices/ListMessagesService";
import ShowTicketService from "../services/TicketServices/ShowTicketService";
import DeleteWhatsAppMessage from "../services/WbotServices/DeleteWhatsAppMessage";
import SendWhatsAppMedia from "../services/WbotServices/SendWhatsAppMedia";
import SendWhatsAppMessage from "../services/WbotServices/SendWhatsAppMessage";
import Whatsapp from "../models/Whatsapp";
import { SendMessage } from "../helpers/SendMessage";

type IndexQuery = {
  pageNumber: string;
};

type MessageData = {
  body: string;
  fromMe: boolean;
  read: boolean;
  quotedMsg?: Message;
  number?: string;
};



export const index = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { pageNumber } = req.query as IndexQuery;

  const { count, messages, ticket, hasMore } = await ListMessagesService({
    pageNumber,
    ticketId
  });

  SetTicketMessagesAsRead(ticket);

  return res.json({ count, messages, ticket, hasMore });
};

export const store = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { body, quotedMsg }: MessageData = req.body;
  const medias = req.files as Express.Multer.File[];

  const ticket = await ShowTicketService(ticketId);

  SetTicketMessagesAsRead(ticket);

  if (medias) {
    await Promise.all(
      medias.map(async (media: Express.Multer.File) => {
        await SendWhatsAppMedia({ media, ticket });
      })
    );
  } else {
    await SendWhatsAppMessage({ body, ticket, quotedMsg });
  }

  return res.send();
};

export const remove = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { messageId } = req.params;

  const message = await DeleteWhatsAppMessage(messageId);

  const io = getIO();
  io.to(message.ticketId.toString()).emit("appMessage", {
    action: "update",
    message
  });

  return res.send();
};

export const send = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { whatsappId } = req.params as unknown as { whatsappId: number; };
  const { openTicket } = req.query;
  const messageData: MessageData = req.body;
  const medias = req.files as Express.Multer.File[];

  try {
    const whatsapp = await Whatsapp.findByPk(whatsappId);

    if (!whatsapp) {
      throw new Error('Não foi possível realizar a operação');
    }

    if (messageData.number === undefined) {
      throw new Error('O número é obrigatório');
    }

    const number = messageData.number;
    let body = messageData.body;

    let ticket: Ticket;
    if (openTicket === "1") {
      const maxTicketId = await Ticket.max("id");
      ticket = await Ticket.create({
        id: maxTicketId + 1,
        userId: req.user.id,
        whatsappId,
        status: "open"
      });
      body = `[Novo ticket aberto]\n\n${body}`;
      await SendMessage({
        message: {
          chatId: whatsapp.id,
          body: body,
        },
        ticket,
      });
    } else {
      ticket = await ShowTicketService(ticketId);
      SetTicketMessagesAsRead(ticket);
    }

    if (medias) {
      await Promise.all(
        medias.map(async (media: Express.Multer.File) => {
          req.app.get('queues')
            .messageQueue.add('SendMessage', {
              whatsappId,
              data: {
                number,
                body: openTicket === "1" ? media.originalname : `\u200c${media.originalname}`,
                mediaPath: media.path,
                ticketId: openTicket === "1" ? ticket.id : ticketId,
              }
            }, { removeOnComplete: true, attempts: 3 });
        })
      );
    } else {
      req.app.get('queues')
        .messageQueue.add('SendMessage', {
          whatsappId,
          data: {
            number,
            body: openTicket === "1" ? body : `\u200c${body}`,
            ticketId: openTicket === "1" ? ticket.id : ticketId,
          }
        }, { removeOnComplete: true, attempts: 3 });
    }
    
    return res.send({ mensagem: 'Mensagem enviada' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};