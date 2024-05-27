const { Telegraf } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const callbackDataStore = new Map();

async function interact(ctx, chatID, request) {
    try {
        const response = await axios({
            method: "POST",
            url: `https://general-runtime.voiceflow.com/state/user/${chatID}/interact`,
            headers: {
                Authorization: process.env.VOICEFLOW_API_KEY,
                versionID: 'production',
            },
            data: { request }
        });

        for (const trace of response.data) {
            const delay = trace.payload && trace.payload.delay ? trace.payload.delay : 100;
            await new Promise(resolve => setTimeout(resolve, delay));

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
                        const callbackId = crypto.randomBytes(8).toString('hex');
                        callbackDataStore.set(callbackId, button.request);
                        return [{ text: button.name, callback_data: callbackId }];
                    });
                    const inlineKeyboard = { reply_markup: { inline_keyboard: buttons } };
                    await ctx.reply("Options:", inlineKeyboard);
                    break;
                case "end":
                    await ctx.reply("End of the conversation");
                    break;
            }
        }
    } catch (error) {
        console.error('Error during interaction with Voiceflow:', error);
        await ctx.reply('An error occurred while processing your request.');
    }
}

async function checkReminders() {
    const now = new Date(); // Use UTC current time
    try {
        const response = await axios.get(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Reminders`, {
            headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
            params: { filterByFormula: "{Status} = 'Pending'" }
        });
        response.data.records.forEach(async (record) => {
            const dueTime = new Date(record.fields['Due Time']);
            if (dueTime <= now) {
                await bot.telegram.sendMessage(process.env.MY_CHAT_ID, `${record.fields.Reminder}`);
                await axios.patch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Reminders/${record.id}`, {
                    fields: { Status: 'Sent' }
                }, {
                    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` }
                });
            }
        });
    } catch (error) {
        console.error('Failed to check or send reminders:', error);
    }
}

cron.schedule('*/30 * * * * *', checkReminders);

async function transcribeVoice(voiceUrl) {
    const tempDir = os.tmpdir();
    const filePath = path.join(tempDir, 'voice.oga');

    try {
        const response = await axios({
            method: 'GET',
            url: voiceUrl,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', async () => {
                try {
                    const transcriptionResponse = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(filePath),
                        model: "whisper-1"
                    });

                    if (transcriptionResponse && transcriptionResponse.text) {
                        resolve(transcriptionResponse.text);
                    } else {
                        console.error('Unexpected response structure:', transcriptionResponse);
                        reject('Transcription failed: No text found in response.');
                    }
                } catch (error) {
                    console.error('Error in OpenAI transcription:', error);
                    reject('Failed to transcribe the voice message: ' + (error.response?.data?.error?.message || error.message));
                } finally {
                    fs.unlinkSync(filePath);  // Delete the temporary file
                }
            });

            writer.on('error', (error) => {
                console.error('Error writing voice file:', error);
                fs.unlinkSync(filePath);  // Ensure deletion on error
                reject('Failed to write voice file.');
            });
        });
    } catch (error) {
        console.error('Error downloading voice message:', error);
        return null;
    }
}

// Handling 'Hi' to reset chat
const greetingRegex = new RegExp(/^hi$/i);
bot.hears(greetingRegex, async (ctx) => {
    let chatID = ctx.message.chat.id;
    await interact(ctx, chatID, { type: "launch" });
});

// Handling any other text
const ANY_WORD_REGEX = new RegExp(/(.+)/i);
bot.hears(ANY_WORD_REGEX, async (ctx) => {
    if (!greetingRegex.test(ctx.message.text)) {
        let chatID = ctx.message.chat.id;
        await interact(ctx, chatID, {
            type: "text",
            payload: ctx.message.text
        });
    }
});

bot.on('voice', async (ctx) => {
    try {
        const voiceFileId = ctx.message.voice.file_id;
        const fileResponse = await bot.telegram.getFile(voiceFileId);
        const voiceUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileResponse.file_path}`;

        const transcription = await transcribeVoice(voiceUrl);
        if (transcription) {
            await interact(ctx, ctx.message.chat.id, { type: "text", payload: transcription });
        } else {
            await ctx.reply('Failed to transcribe the voice message.');
        }
    } catch (error) {
        console.error('Error processing voice message:', error);
        await ctx.reply('Sorry, something went wrong processing your voice message.');
    }
});

bot.on('callback_query', async (ctx) => {
    let chatID = ctx.callbackQuery.message.chat.id;
    let callbackId = ctx.callbackQuery.data;
    let request = callbackDataStore.get(callbackId);
    if (request) {
        await interact(ctx, chatID, request);
        callbackDataStore.delete(callbackId);
    } else {
        await ctx.reply("Invalid selection, please try again.");
    }
});

bot.on(['photo', 'document'], async (ctx) => {
    try {
        let fileUrl;
        if (ctx.message.photo) {
            const file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            const fileResponse = await bot.telegram.getFile(file_id);
            const filePath = fileResponse.file_path;
            fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`;
        } else if (ctx.message.document && ctx.message.document.mime_type === 'application/pdf') {
            const fileId = ctx.message.document.file_id;
            const fileResponse = await bot.telegram.getFile(fileId);
            const filePath = fileResponse.file_path;
            fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`;
        } else {
            await ctx.reply('Only images and PDF files are supported. Please upload a valid file.');
            return;
        }
        ctx.message.text = fileUrl;
        await interact(ctx, ctx.message.chat.id, { type: "text", payload: fileUrl });
    } catch (error) {
        console.error('Error while processing file:', error);
        await ctx.reply('Sorry, something went wrong while processing your file.');
    }
});

bot.start(async (ctx) => {
    let chatID = ctx.message.chat.id;
    await interact(ctx, chatID, { type: "launch" });
});

bot.launch(); // Start the bot

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
