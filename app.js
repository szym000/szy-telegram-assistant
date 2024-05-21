const { Telegraf } = require('telegraf'); // import telegram lib
const axios = require('axios');
const crypto = require('crypto');

require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN); // get the token from environment variable

// In-memory store for callback data
const callbackDataStore = new Map();

async function interact(ctx, chatID, request) {
    try {
        const response = await axios({
            method: "POST",
            url: `https://general-runtime.voiceflow.com/state/user/${chatID}/interact`,
            headers: {
                Authorization: process.env.VOICEFLOW_API_KEY
            },
            data: {
                request
            }
        });

        for (const trace of response.data) {
            switch (trace.type) {
                case "text":
                case "speak":
                    await ctx.reply(trace.payload.message);
                    break;
                case "visual":
                    await ctx.replyWithPhoto(trace.payload.image);
                    break;
                case "choice":
                    const buttons = trace.payload.buttons.map(button => {
                        // Generate a short unique identifier for the callback data
                        const callbackId = crypto.randomBytes(8).toString('hex');
                        // Store the detailed request data in the map
                        callbackDataStore.set(callbackId, button.request);
                        return [{ text: button.name, callback_data: callbackId }];
                    });
                    const inlineKeyboard = { reply_markup: { inline_keyboard: buttons } };
                    await ctx.reply("Options:", inlineKeyboard);
                    break;
                case "end":
                    await ctx.reply("Conversation is over");
                    break;
            }
        }
    } catch (error) {
        console.error('Error during interaction with Voiceflow:', error);
        await ctx.reply('An error occurred while processing your request.');
    }
}

bot.start(async (ctx) => {
    let chatID = ctx.message.chat.id;
    await interact(ctx, chatID, { type: "launch" });
});

const ANY_WORD_REGEX = new RegExp(/(.+)/i);
bot.hears(ANY_WORD_REGEX, async (ctx) => {
    let chatID = ctx.message.chat.id;
    await interact(ctx, chatID, {
        type: "text",
        payload: ctx.message.text
    });
});

bot.on('callback_query', async (ctx) => {
    let chatID = ctx.callbackQuery.message.chat.id;
    let callbackId = ctx.callbackQuery.data;
    // Retrieve the detailed request data from the map
    let request = callbackDataStore.get(callbackId);
    if (request) {
        await interact(ctx, chatID, request);
        // Optionally, remove the data from the map if it's only needed once
        callbackDataStore.delete(callbackId);
    } else {
        await ctx.reply("Invalid selection, please try again.");
    }
});

bot.on('photo', async (ctx) => {
    try {
        const file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id; // Get the file_id of the highest resolution photo

        // Get the file path using getFile method
        const fileResponse = await bot.telegram.getFile(file_id);
        const filePath = fileResponse.file_path;

        // Construct the URL to access the file
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`;

        // Simulate user sending the URL message
        const chatID = ctx.message.chat.id;
        const username = ctx.message.from.username ? `@${ctx.message.from.username}` : ctx.message.from.first_name;

        // Temporarily modify the message to include the URL as if the user had sent it
        ctx.message.text = fileUrl;

        // Interact with the Voiceflow API using the image URL
        await interact(ctx, chatID, {
            type: "text",
            payload: fileUrl
        });

    } catch (error) {
        console.error('Error while getting file URL:', error);
        await ctx.reply('Sorry, something went wrong while retrieving the image URL.');
    }
});

bot.launch(); // start

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
