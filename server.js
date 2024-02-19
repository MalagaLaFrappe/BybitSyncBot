//DEVNOTE
//developed by ROM CLOUDIA
//forza Napoli

import WebSocket from "ws";
import { promisify } from "util";
import dotenv from "dotenv";
import crypto from "crypto";
import { LinearClient, RestClientV5 } from "bybit-api";
import { response } from "express";
import { error } from "console";
// import {BybitExchange } from "../exchange/bybitHelper";

const delay = promisify(setTimeout);
const PING_INTERVAL = 20 * 1000;
const HEARTBEAT_INTERVAL = 25 * 1000;
const URL = "https://api.bybit.com";

let pingTrigger;
let heartbeatTrigger;
let ws;
let subs = [];

// MAIN FUNCTIONS
function restart() {
  if (ws) ws.terminate();
  ws = new WebSocket("wss://stream.bybit.com/v5/private");  //wss://stream.bybit.com/v5/private
  ws.on("open", onOpen);
  ws.on("message", onMessage);
  ws.on("error", onError);
  ws.on("pong", onPong);

  clearInterval(pingTrigger);
  pingTrigger = setInterval(() => {
    if (!(ws.readyState === WebSocket.OPEN)) return;
    ws.ping();
  }, PING_INTERVAL);
}

function subscribe(topics) {
  // topics = []
  subs = topics;
  if (!(ws.readyState === WebSocket.OPEN)) return;
  ws.send(JSON.stringify({ op: "subscribe", args: topics }));
}

function unsubscribe(topics) {
  // topics = []
  subs = subs.filter((d) => !topics.include(d));
  if (!(ws.readyState === WebSocket.OPEN)) return;
  ws.send(JSON.stringify({ op: "unsubscribe", args: topics }));
}

function generateAuthToken({ API, SEC }) {
  const expires = new Date().getTime() + 10000;
  const signature = crypto
    .createHmac("sha256", SEC)
    .update("GET/realtime" + expires)
    .digest("hex");
  const payload = { op: "auth", args: [API, expires.toFixed(0), signature] };
  //console.log(payload);
  return JSON.stringify(payload);
  
}

// CONTROL FRAMES
const onOpen = () => {
  console.log("WS OPEN");

  //authentication
  const { API, SEC } = process.env;
  const authToken = generateAuthToken({ API, SEC });
  ws.send(authToken);

  if (!(ws.readyState === WebSocket.OPEN)) return;
  if (!subs.length) return;
  ws.send(JSON.stringify({ op: "subscribe", args: subs }));
};

const onPong = () => {
  console.log("WS PONG RECEIVED!");
  clearTimeout(heartbeatTrigger);
  
  heartbeatTrigger = setTimeout(() => {
    console.log("HEARTBEAT TRIGGERED");
    restart();
  }, HEARTBEAT_INTERVAL);
  
};




//EVENTO APERTURA ORDINI
const onMessage = (pl) => {

  console.log(pl.toString());

  //deserializzazione messaggio dal ws del master
  let obj_pl = JSON.parse(pl.toString());

  //crea client master
  const { API, SEC } = process.env;
  const MASTER_CLIENT_V5 =  new RestClientV5({
    key : API,
    secret: SEC,
    useTestnet: false
  });
  //crea client copiatore
  const { COPIERAPI, COPIERSECRET } = process.env;
  const COPIER_CLIENT_V5 =  new RestClientV5({
    key : COPIERAPI,
    secret: COPIERSECRET,
    useTestnet: false
  });

  //dichiaro balance dei conti
  let master_total_usdt_balance = 0;
  let copier_total_usdt_balance = 0;

  //dichiaro quantita minima decimali 
  let qty_min = 0;
  let qty_decimal = 1;

  //dichiaro lista di posizioni master
  let masterPositions = [];
  let copierPositions = [];

  
  //SETTA LA LEVA UGUALE
  if(obj_pl.topic=="position")
  {
    // const getMasterPositionPromise = MASTER_CLIENT_V5.getPositionInfo({
    //   category:"linear",
    //    symbol:"MANTAUSDT"
    // }).then(response => {
    //   console.log(response.result.list);
    // }).catch(error=>{
    //   console.error(error);
    // });
    (async() =>{
        try{
          let setResult = await COPIER_CLIENT_V5.setLeverage({
            category: obj_pl.data[0].category,
            symbol: obj_pl.data[0].symbol,
            buyLeverage: obj_pl.data[0].leverage.toString(),
            sellLeverage: obj_pl.data[0].leverage.toString()
          });
          console.log(setResult);
        }
        catch (e) {
          console.error('leverage set failed: ', e);
        }
    })();
  }

  if(obj_pl.topic=="order"){

  const getMasterBalancePromise = MASTER_CLIENT_V5.getWalletBalance({
    accountType: "UNIFIED",
    coin: "USDT"
  }).then(response => {
    master_total_usdt_balance = response.result.list[0].totalEquity;
  }).catch(error => {
    console.error('Failed to get master balance: ', error);
  });
  
  // Promessa per ottenere il bilancio del copiatore
  const getCopierBalancePromise = COPIER_CLIENT_V5.getWalletBalance({
    accountType: "UNIFIED",
    coin: "USDT"
  }).then(response => {
    copier_total_usdt_balance = response.result.list[0].totalEquity;
  }).catch(error => {
    console.error('Failed to get copier balance: ', error);
  });

  //promessa per ottenere quantita minima della coppia
  const minOrderQtyPromise = MASTER_CLIENT_V5.getInstrumentsInfo({
    category: obj_pl.data[0].category,
    symbol: obj_pl.data[0].symbol,
    }).then(response => {
      qty_min =  response.result.list[0].lotSizeFilter.minOrderQty;
    }).catch(error => {
      console.error(error);
      qty_min = 0;
  });


  //POSIZIONI NO TP/SL
  if(obj_pl.data[0].orderStatus=="Filled")
  {




    //FIX DI EMERGENZA 
    
    // if(obj_pl.data[0].symbol=="BTCUSDT"){
    //   qty_decimal=3;
    // }
    // if(obj_pl.data[0].symbol=="ETHUSDT"){
    //   qty_decimal=2;
    // }

    Promise.all([getMasterBalancePromise, getCopierBalancePromise,minOrderQtyPromise]).then(() => {
      qty_decimal = calculateQtyDecimal(qty_min);
      let qty_client = ((obj_pl.data[0].qty * copier_total_usdt_balance) / master_total_usdt_balance).toFixed(qty_decimal);
      (async () => {
        try{
          let orderResult = await COPIER_CLIENT_V5.submitOrder({
            category: obj_pl.data[0].category,
            symbol: obj_pl.data[0].symbol,
            orderType: obj_pl.data[0].orderType,
            qty:qty_client.toString(),
            side: obj_pl.data[0].side,
          });
          console.log(orderResult);
        }
        catch (e) {
          console.error('request failed: ', e);
        }
      })();
    }).catch(error => {
      console.error('Failed to get balances: ', error);
    });
  }

  //GESTIONE TP/SL
  if(obj_pl.data.length>1)
  {
    if(obj_pl.data[1].orderStatus=="Filled")
    {

    // //CONTROLLO PER POSIZIONI (NON CHIUDO SUL CLIENT SE CHIUDE PRIMA DEL MASTER)
    // //prendi posione attive master
    // const getMasterPositionPromise = MASTER_CLIENT_V5.getPositionInfo({
    //   category:obj_pl.data[1].category,
    //   symbol:obj_pl.data[1].symbol
    //  }).then(response => {
    //   console.log(response.result.list);
    // }).catch(error=>{
    //   console.error(error);
    // });

    // //prendi posione attive copiatore
    // const getCopierPositionPromise = COPIER_CLIENT_V5.getPositionInfo({
    //   category:obj_pl.data[1].category,
    //   symbol:obj_pl.data[1].symbol
    //   }).then(response => {
    //   console.log(response.result.list);
    // }).catch(error=>{
    //   console.error(error);
    // });

    // Promise.all([getMasterPositionPromise,getCopierPositionPromise]).then(()=>{
    //   const numMasterPositions = masterPositions.result.list.filter(position => position.side !== "").length;
    //   const numCopierPositions = copierPositions.result.list.filter(position => position.side !== "").length;

    //   if (numMasterPositions === numCopierPositions) {
    //     return;
    //   }
    // }).catch(error =>{
    //   console.error('Failed to get positions: ', error);
    // })
      



    Promise.all([getMasterBalancePromise, getCopierBalancePromise]).then(() => {
        let qty_client = ((obj_pl.data[0].qty * copier_total_usdt_balance) / master_total_usdt_balance).toFixed(1);
        (async () => {
          try{
            let orderResult = await COPIER_CLIENT_V5.submitOrder({
              category: obj_pl.data[1].category,
              symbol: obj_pl.data[1].symbol,
              orderType: obj_pl.data[1].orderType,
              qty:qty_client.toString(),
              side: obj_pl.data[1].side,
              takeProfit: obj_pl.data[1].takeProfit,
              stopLoss: obj_pl.data[1].stopLoss
            });
            console.log(orderResult);
          }
          catch (e) {
            console.error('request failed: ', e);
          }
        })();
      }).catch(error => {
        console.error('Failed to get balances: ', error);
      });
    }
  }
  }
};


const onError = async (err) => {
  console.error(err);
  await delay(5000);
  restart();
};



// CORE LOGIC - MAIN
(async () => {
  dotenv.config();
  restart();
  subscribe(["order","position"]);
})();



//functions
function calculateQtyDecimal(minOrderQty) {
  const [, decimals] = minOrderQty.split('.');
  return decimals ? decimals.length : 0;
}


