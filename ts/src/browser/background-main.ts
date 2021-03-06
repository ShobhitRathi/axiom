// This code runs in the persistent background page.
import LocalStorage from "./LocalStorage";
import NetworkConfig from "../iso/NetworkConfig";
import Storage from "./Storage";
import TorrentClient from "../iso/TorrentClient";
import TorrentDownloader from "./TorrentDownloader";
import TrustedClient from "./TrustedClient";

// Parcel will automatically insert this variable
declare var process: any;

let storage = new Storage(new LocalStorage());
(window as any).storage = storage;
TrustedClient.init(storage, process.env.NETWORK);

// Work around requestIdleCallback issue
// https://stackoverflow.com/questions/55461030/does-requestidlecallback-work-in-the-background-page-of-chrome-extensions
(window as any).requestIdleCallback = f => f();

// Creates a pac script so that all .axiom URLs get proxied to a
// black hole server.
//
// All that a "black hole server" needs to do is return a valid http
// response. It can be blank. It can be any other content, too, since
// the extension will stop all content loading and load the real site
// via the distributed system. So the content might as well be blank.
//
// We need to do this method for redirecting .axiom domains so that
// the URL still appears as .axiom in the browser. I think this
// necessary so that the behavior is comprehensible to the end user.
//
// This is not ideal architecturally. In particular, information on
// what URLs we are loading does get leaked to the proxy. And we are
// dependent on finding a usable proxy site. But I think the tradeoff
// is worth it for increased usability.
function buildBlackHoleScript(server) {
  let script = `
    function FindProxyForURL(url, host) {
      if (shExpMatch(host, "*.axiom")) {
        return "PROXY ${server}";
      }
      return 'DIRECT';
    }
  `;
  return script;
}

// Update the black hole proxy
async function setBlackHoleProxy(server) {
  let script = buildBlackHoleScript(server);
  let config = {
    mode: "pac_script",
    pacScript: {
      data: script
    }
  };

  return await new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value: config, scope: "regular" }, () => {
      console.log("proxy settings updated. black hole is", server);
      resolve();
    });
  });
}

console.log("configuring extension for the", process.env.NETWORK, "network");
let config = new NetworkConfig(process.env.NETWORK);

// The network config tells us where to find our black hole proxy
setBlackHoleProxy(config.getProxy()).then(() => {
  console.log("initial black hole proxy configuration complete");
});

let downloader = new TorrentDownloader(process.env.NETWORK);
downloader.verbose = true;

// Handle non-html requests by redirecting them to a data URL
chrome.webRequest.onBeforeRequest.addListener(
  details => {
    let url = new URL(details.url);
    let file = downloader.getFileFromCache(url.hostname, url.pathname);
    if (!file || !file.data) {
      console.log("no data found for", url.hostname, url.pathname);
      return { cancel: true };
    }
    console.log("data found for", url.hostname, url.pathname);
    return { redirectUrl: file.data };
  },
  {
    urls: ["*://*.axiom/*"],
    types: [
      "font",
      "image",
      "media",
      "object",
      "script",
      "stylesheet",
      "xmlhttprequest"
    ]
  },
  ["blocking"]
);

// Just logs completed axiom navigation requests
chrome.webRequest.onCompleted.addListener(
  details => {
    let url = new URL(details.url);
    console.log("html request completed for", url.hostname, url.pathname);
  },
  {
    urls: ["*://*.axiom/*"],
    types: ["main_frame", "sub_frame"]
  }
);

// Listen for the loader wanting a file
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message.getFile) {
    return false;
  }

  let { hostname, pathname } = message.getFile;
  downloader
    .inlineJavaScript(hostname, pathname)
    .then(html => {
      // This assumes that anything typed in directly by the user is html.
      // TODO: handle non html stuff
      console.log("sending", html.length, "bytes of html response");
      sendResponse(html);
    })
    .catch(e => {
      console.log("sending error response:", e);
      sendResponse({ error: e.message });
    });
  return true;
});
