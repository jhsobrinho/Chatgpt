import WAWebJS, { MessageMedia } from "whatsapp-web.js";
import Whatsapp from "../models/Whatsapp";
import GetWhatsappWbot from "./GetWhatsappWbot";

export type MessageData = {
  number: number | string;
  body: string;
  mediaPath?: string;
};

export const SendMessage = async (whatsapp: Whatsapp, messageData: MessageData): Promise<WAWebJS.Message> => {
  try {
    const wbot = await GetWhatsappWbot(whatsapp);
    const chatId = `${messageData.number}@c.us`;

    let message: WAWebJS.Message;
    const body = `\u200e${messageData.body}`;

    if (messageData.mediaPath) {
      const mediaPath = MessageMedia.fromFilePath(messageData.mediaPath);
      message = await wbot.sendMessage(chatId, mediaPath, { sendAudioAsVoice: true });
    } else {
      message = await wbot.sendMessage(chatId, body);
    }

    return message;
  } catch (err: any) {
    throw new Error(err);
  }
}
