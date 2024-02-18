import WebSocket from "ws";

let ws;

ws = new WebSocket("wss://stream.bybit.com/spot/public/v3");

ws.on("open", () => {
  console.log("WS OPEN");
  ws.send(JSON.stringify({ op: "subscribe", args: ["kline.30m.BTCUSDT"] }));
});

ws.on("message", (pl) => {
  console.log(pl.toString());
});
