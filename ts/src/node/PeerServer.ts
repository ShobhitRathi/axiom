import * as WebSocket from "ws";

import Peer from "../iso/Peer";

// A PeerServer listens for websockets and exchanges enough information over them
// to construct a Peer connection.
export default class PeerServer {
  verbose: boolean;
  peerHandler: (Peer) => void;
  port: number;
  wss: WebSocket.Server;

  constructor(port: number, verbose: boolean) {
    this.port = port;
    this.verbose = verbose;
    this.peerHandler = null;

    this.wss = new WebSocket.Server({ port: port });
    this.wss.on("connection", ws => {
      console.log("XXX creating server peer");
      let peer = new Peer({ verbose: verbose });

      peer.onSignal(data => {
        console.log("XXX server sending signal:", data);
        ws.send(data);
      });

      peer.onConnect(() => {
        console.log("XXX server sees connection");
      });

      ws.on("message", data => {
        console.log("XXX server got signal:", data);
        peer.signal(data);
      });

      if (this.peerHandler) {
        this.peerHandler(peer);
      }
    });
  }

  log(...args) {
    if (this.verbose) {
      console.log(...args);
    }
  }

  onPeer(callback: (Peer) => void) {
    if (this.peerHandler) {
      throw new Error("onPeer can only be called once");
    }
    this.peerHandler = callback;
  }
}
