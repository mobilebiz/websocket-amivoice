const express = require("express");
const WebSocket = require("ws");
const { Vonage } = require('@vonage/server-sdk');
const req = require("express/lib/request");
const OpenAI = require("openai");
require('dotenv').config();

// answerBot の発声を AmiVoice が読みとり、
// それをまた answerBot が発声する無限ループ防止に、
// answerBot が通話中は AmiVoice を一時的に止める
let enabledAmiVoice = true;

const CONVERSATION_NAME = "TODO_USE_UUID";
let SERVER = "";

// https://platform.openai.com/docs/api-reference/introduction
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());
require("express-ws")(app);

const vonage = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: process.env.VONAGE_PRIVATE_KEY_PATH,
});

// OpenAI の script を使って回答する
const answerOpenAiBot = async (text) => {
  // Assuming the correct method is `generate` or similar
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "質問に対してなるべく丁寧に回答してください。回答はなるべく簡潔に、100文字程度で話し言葉で返答してください。" },
      { role: "user", content: text }
    ],
  });
  const answer = response.choices[0].message.content;
  console.log(`🐞 answerOpenAiBot: ${answer}`);
  return answer;
};

// AnswerBot: text を変更することでボットになる
const answerBot = async (text) => {
  // OpenAI の script を使って回答する
  const answer = await answerOpenAiBot(text);

  // https://developer.vonage.com/en/voice/voice-api/ncco-reference?source=voice
  const ncco = [{
    action: "talk",
    language: "ja-JP",
    style: 3,
    premium: true,
    text: answer,
  }];

  // https://developer.vonage.com/en/voice/voice-api/code-snippets/making-calls/make-an-outbound-call-with-ncco?source=voice&lang=javascript
  vonage.voice.createOutboundCall({
    ncco: ncco,
    to: [{
      type: 'phone',
      number: process.env.VONAGE_NUMBER,
    }],
    from: {
      type: 'phone',
      number: process.env.VONAGE_NUMBER,
    },
    eventUrl: [`https://${SERVER}/answerBot/event`],
  })
    .then((result) => console.log(result))
    .catch((error) => console.error(error));
};

const isAnswerBot = (from) => {
  // なぜか t000216428 のようなことがあるため暫定対応（調査中）
  return from === process.env.VONAGE_NUMBER || from.startsWith("t")
}

// 回答 URL: 電話着信時に実行される処理
app.post("/answer", (req, res) => {
  SERVER = req.hostname;
  console.log(`🐞 /answer called. ${SERVER}`);
  if (isAnswerBot(req.body.from)) {
    res.status(200).json([{
      action: "conversation",
      name: CONVERSATION_NAME,
    }]);
  } else {
    const ncco = [
      {
        action: "talk",
        language: "ja-JP",
        text: "お電話ありがとうございます。質問にはなるべく丁寧に答えますので、お気軽にお話しください。",
      },
      {
        action: "connect",
        endpoint: [
          {
            type: "websocket",
            "content-type": "audio/l16;rate=8000",
            uri: `wss://${SERVER}/websocket`,
          },
        ],
      },
      {
        action: "conversation",
        endOnExit: true,
        name: CONVERSATION_NAME,
      },
    ];

    res.status(200).json(ncco);
  }
});

app.post("/answerBot/event", (req, res) => {
  if (req.body.status === "completed") {
    enabledAmiVoice = true;
    console.log("enabled to AmiVoice")
  }
  res.status(200).end();
});

app.post("/event", (req, res) => {
  res.status(200).end();
});

app.ws("/websocket", (ws, _req) => {
  console.log("connected to Vonage");

  let wsAmiVoiceOpened = false;

  // https://docs.amivoice.com/amivoice-api/manual/log-retention/
  const wsAmiVoice = new WebSocket("wss://acp-api.amivoice.com/v1/nolog/");

  wsAmiVoice.on("open", () => {
    console.log("connected to AmiVoice");
    wsAmiVoiceOpened = true;
    // https://docs.amivoice.com/amivoice-api/manual/reference-websocket-s-command-packet
    wsAmiVoice.send(
      `s LSB8K -a-general authorization=${process.env.AMIVOICE_KEY}`
    );
  });

  wsAmiVoice.on("message", (message) => {
    // console.log('message:', message);
    // https://docs.amivoice.com/amivoice-api/manual/reference-websocket-a-event-packet
    if (typeof message === "string" && message[0] === "A") {
      try {
        const data = JSON.parse(message.slice(2));
        if (data.text !== "") {
          console.log("result", data.text);

          enabledAmiVoice = false
          console.log("disabled to AmiVoice")

          answerBot(data.text)
        }
      } catch (error) {
        console.error("Error parsing AmiVoice message:", error, message);
      }
    }
  });

  wsAmiVoice.on("error", (error) => {
    console.error("Error connecting to AmiVoice:", error);
  });

  ws.on("message", (message) => {
    if (wsAmiVoiceOpened && enabledAmiVoice) {
      // https://docs.amivoice.com/amivoice-api/manual/reference-websocket-p-command-packet
      const pBuffer = Buffer.from("p");
      const audioBuffer = Buffer.from(message, "base64");
      wsAmiVoice.send(Buffer.concat([pBuffer, audioBuffer]));
    }
  });

  ws.on("close", () => {
    console.log("closed to Vonage");
    if (wsAmiVoiceOpened) {
      console.log("closed to AmiVoice");
      wsAmiVoice.close();
    }
  });
});

app.listen(port, () => console.log(`server listening on port ${port}`));
