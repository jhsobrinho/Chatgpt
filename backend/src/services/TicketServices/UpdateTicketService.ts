import CheckContactOpenTickets from "../../helpers/CheckContactOpenTickets";
import SetTicketMessagesAsRead from "../../helpers/SetTicketMessagesAsRead";
import { getIO } from "../../libs/socket";
import Ticket from "../../models/Ticket";
import ShowTicketService from "./ShowTicketService";
import Queue from "../../models/Queue";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import { verifyMessage } from "../WbotServices/wbotMessageListener";
import { isNil } from "lodash"

interface TicketData {
  status?: string;
  userId?: number;
  queueId?: number | null;
  chatbot?: boolean;
  queueOptionId?: number;
}

interface Request {
  ticketData: TicketData;
  ticketId: string | number;
}

interface Response {
  ticket: Ticket;
  oldStatus: string;
  oldUserId: number | undefined;
}

const UpdateTicketService = async ({
  ticketData,
  ticketId
}: Request): Promise<Response> => {
  const { status, userId } = ticketData;
  let { queueId } = ticketData
  let chatbot: boolean | null = ticketData.chatbot || false
  let queueOptionId: number | null = ticketData.queueOptionId || null

  const ticket = await ShowTicketService(ticketId);

  await SetTicketMessagesAsRead(ticket);

  const oldStatus = ticket.status;
  const oldUserId = ticket.user?.id;
  const oldQueueId = ticket.queueId;

  if (oldStatus === "closed") {
    await CheckContactOpenTickets(ticket.contact.id);
  }

  if (status === "closed") {
    queueId = null;
    chatbot = null;
    queueOptionId = null;
  }

  if (oldQueueId !== queueId && !isNil(oldQueueId) && !isNil(queueId)) {
    const queue = await Queue.findByPk(queueId);
    let body = `\u200e${queue?.greetingMessage}`;
    const wbot = await GetTicketWbot(ticket);

    const queueChangedMessage = await wbot.sendMessage(`${ticket.contact.number}@c.us`, '\u200eVocê foi transferido, em breve iremos iniciar seu atendimento.');
    await verifyMessage(queueChangedMessage, ticket, ticket.contact);

    // mensagem padrão desativada em caso de troca de fila
    // const sentMessage = await wbot.sendMessage(`${ticket.contact.number}@c.us`, body);
    // await verifyMessage(sentMessage, ticket, ticket.contact);
  }

  await ticket.update({
    status,
    queueId,
    userId,
    chatbot,
    queueOptionId
  });

  await ticket.reload();

  const io = getIO();

  if (ticket.status !== oldStatus || ticket.user?.id !== oldUserId) {
    io.to(oldStatus).emit("ticket", {
      action: "delete",
      ticketId: ticket.id
    });
  }

  io.to(ticket.status)
    .to("notification")
    .to(ticketId.toString())
    .emit("ticket", {
      action: "update",
      ticket
    });

  return { ticket, oldStatus, oldUserId };
};

export default UpdateTicketService;
