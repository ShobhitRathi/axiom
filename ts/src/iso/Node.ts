import { isEmpty } from "./Util";
import KeyPair from "./KeyPair";
import Message from "./Message";
import Peer from "./Peer";
import SignedMessage from "./SignedMessage";

// A Node represents a member of the Axiom peer-to-peer network.
// See the README in this directory for a description of message formats.
export default class Node {
  verbose: boolean;

  // Every connection in peers should already be connected.
  // When a peer disconnects, it is destroyed.
  // A node should only store one Peer per public key.
  // If we do not know the public key of a Peer yet, it is not stored in peers.
  peers: { [publicKey: string]: Peer };

  // The Peers that are being connected via server but aren't connected yet.
  // The key is WebSocket url, the value is the Peer.
  // Once the peer connects, the value is replaced with a null.
  // This way the keys with null values are things we can retry.
  pendingByURL: { [url: string]: Peer };

  // The Peers that we are interested in connecting to.
  // Maps publicKey we are interested in, to the key of the
  // intermediary who might connect us.
  pendingByPublicKey: { [publicKey: string]: string };

  // Callbacks that will run on the next message received
  nextMessageCallbacks: ((SignedMessage) => void)[];

  // Callbacks that will run on every message received
  everyMessageCallbacks: ((SignedMessage) => void)[];

  // Whether this Node has been destroyed
  destroyed: boolean;

  keyPair: KeyPair;

  // A Node doesn't start connecting to the network until you call bootstrap()
  constructor(keyPair: KeyPair, urls: string[], verbose: boolean) {
    this.keyPair = keyPair;
    if (!this.keyPair) {
      this.keyPair = KeyPair.fromRandom();
    }

    this.pendingByURL = {};
    for (let url of urls) {
      this.pendingByURL[url] = null;
    }

    this.destroyed = false;
    this.verbose = verbose;
    this.peers = {};
    this.nextMessageCallbacks = [];
    this.everyMessageCallbacks = [];
  }

  log(...args) {
    if (this.verbose) {
      console.log(...args);
    }
  }

  // Returns the number of peers for which we have identified their public key
  numPeers(): number {
    let answer = 0;
    for (let key in this.peers) {
      answer++;
    }
    return answer;
  }

  // Starts to connect to any peer that we aren't already in the process of
  // connecting to
  bootstrap() {
    for (let url in this.pendingByURL) {
      this.connectToServer(url);
    }
  }

  onNextMessage(callback: (SignedMessage) => void) {
    this.nextMessageCallbacks.push(callback);
  }

  onEveryMessage(callback: (SignedMessage) => void) {
    this.everyMessageCallbacks.push(callback);
  }

  // Returns the next time we receive a SignedMessage
  async waitForMessage(): Promise<SignedMessage> {
    return new Promise((resolve, reject) => {
      this.onNextMessage(resolve);
    });
  }

  // Calls f both right now and after every received message.
  // Once it is true, this function completes.
  async waitUntil(f: () => boolean) {
    while (!f()) {
      await this.waitForMessage();
    }
  }

  // Destroys the peer if it is redundant
  // Returns whether the peer was indexed
  indexPeer(peer: Peer): boolean {
    if (this.peers[peer.peerPublicKey]) {
      // We already have a peer connection open to this node
      peer.destroy();
      return false;
    }

    this.peers[peer.peerPublicKey] = peer;
    return true;
  }

  // Starts connecting to a new peer whose public key we know, via an intermediary that
  // we're already connected to.
  connectToPeer(publicKey: string, intermediary: Peer) {
    if (this.peers[publicKey] || this.pendingByPeer[publicKey]) {
      // A connection is already in progress
      return;
    }

    console.log("XXX TODO");
  }

  // Returns immediately rather than waiting for the connection
  connectToServer(url: string) {
    if (this.destroyed) {
      return;
    }
    if (!(url in this.pendingByURL)) {
      throw new Error("cannot connect to new url: " + url);
    }
    if (this.pendingByURL[url]) {
      // A connection to this url is already in progress
      return;
    }
    let peer = Peer.connectToServer(this.keyPair, url, this.verbose);
    peer.onConnect(() => {
      this.addPeer(peer);
    });
    this.pendingByURL[url] = peer;
  }

  handleSignedMessage(peer: Peer, sm: SignedMessage) {
    if (peer.peerPublicKey && this.peers[peer.peerPublicKey] !== peer) {
      // We received a message from a peer that we previously removed
      return;
    }

    if (!peer.peerPublicKey) {
      // We have just learned the identity of this peer
      if (sm.signer === this.keyPair.getPublicKey()) {
        // Oops, we connected to ourselves. Hang up
        peer.destroy();
        return;
      }
      peer.peerPublicKey = sm.signer;
      this.indexPeer(peer);
    }

    let message = sm.message;
    if (message.type === "Ping") {
      peer.sendMessage(new Message("Pong"));
    } else if (message.type === "Pong") {
      // Ignore
    } else if (message.type === "FindNode") {
      // Find all the neighbors besides the one talking to us
      // TODO: use real Kademlia algorithm
      let neighbors = [];
      for (let pk in this.peers) {
        if (pk !== peer.peerPublicKey) {
          neighbors.push(pk);
        }
      }
      let response = new Message("Neighbors", {
        neighbors: neighbors,
        responseID: message.requestID
      });
      peer.sendMessage(response);
    } else if (message.type === "Neighbors") {
      for (let publicKey of message.neighbors) {
        this.connectToPeer(publicKey, peer);
      }
    } else {
      this.log("unexpected message type:", message.type);
    }

    let nextCallbacks = this.nextMessageCallbacks;
    this.nextMessageCallbacks = [];
    let everyCallbacks = [...this.everyMessageCallbacks];
    for (let callback of nextCallbacks) {
      callback(sm);
    }
    for (let callback of everyCallbacks) {
      callback(sm);
    }
  }

  // Ownership of the peer passes to this Node.
  addPeer(peer: Peer) {
    if (this.destroyed) {
      return;
    }
    if (!peer.isConnected()) {
      throw new Error("only connected peers can be added to a Node");
    }

    if (peer.url) {
      if (this.pendingByURL[peer.url] !== peer) {
        throw new Error("bad pendingByURL");
      }
      this.pendingByURL[peer.url] = null;
    }

    if (peer.peerPublicKey) {
      if (peer.peerPublicKey == this.keyPair.getPublicKey()) {
        return;
      }
      if (!this.indexPeer(peer)) {
        return;
      }
    } else {
      peer.ping();
    }

    peer.onClose(() => {
      let alreadyEmpty = isEmpty(this.peers);

      if (this.peers[peer.peerPublicKey] === peer) {
        delete this.peers[peer.peerPublicKey];
      }

      if (!alreadyEmpty && isEmpty(this.peers) && !this.destroyed) {
        this.log("lost connection to every node. rebootstrapping...");
        this.bootstrap();
      }
    });

    peer.onSignedMessage(sm => {
      this.handleSignedMessage(peer, sm);
    });
  }

  getPeers(): Peer[] {
    let answer = [];
    for (let key in this.peers) {
      answer.push(this.peers[key]);
    }
    return answer;
  }

  destroy() {
    this.destroyed = true;
    for (let peer of this.getPeers()) {
      peer.destroy();
    }
  }
}
