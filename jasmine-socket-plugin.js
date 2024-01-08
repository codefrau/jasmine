/*
 * Croquet Jasmine Socket Plugin
 *
 * This plugin is a modified version of the SocketPlugin from the SqueakJS project.
 * It is used to provide a networking for the Jasmine Smalltalk image.
 * It emulates an IP network (TCP and UDP) by joining a (modern) Croquet.io session.
 * That network has no connection to any "real" network, it is purely virtual.
 *
 * Note that the use of croquet.io is purely to emulate that network, the actual
 * synchronization logic is all inside the (old) Smalltalk image. That also makes it
 * useful beyond just Jasmine. It should be able to support e.g. Croquet Hedgehog and
 * other networked Croquet apps as well (e.g. a Seaside server image, and a client
 * image accessing it).
 *
 * TODO:
 * [x] UDP
 * [ ] TCP
 * [ ] chunked reads
 * [ ] chunked writes?
 * [ ] fragmentation for oversized packets
 * [ ] leave Croquet session when no longer needed (all sockets destroyed, or maybe
 *     unconnected for a while)
 *
 * ORIGINAL COMMENT FROM SOCKET PLUGIN by Fabio Niephaus:
 *
 * This Socket plugin only fulfills http:/https:/ws:/wss: requests by intercepting them
 * and sending as either XMLHttpRequest or Fetch or WebSocket.
 * To make connections to servers without CORS, it uses a CORS proxy.
 *
 * When a WebSocket connection is created in the Smalltalk image a low level socket is
 * assumed to be provided by this plugin. Since low level sockets are not supported
 * in the browser a WebSocket is used here. This does however require the WebSocket
 * protocol (applied by the Smalltalk image) to be 'reversed' or 'faked' here in the
 * plugin.
 * The WebSocket handshake protocol is faked within the plugin and a regular WebSocket
 * connection is set up with the other party resulting in a real handshake.
 * When a (WebSocket) message is sent from the Smalltalk runtime it will be packed
 * inside a frame (fragment). This Socket plugin will extract the message from the
 * frame and send it using the WebSocket object (which will put it into a frame
 * again). A bit of unnecessary byte and bit fiddling unfortunately.
 * See the following site for an explanation of the WebSocket protocol:
 * https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers
 *
 * DNS requests are done through DNS over HTTPS (DoH). Quad9 (IP 9.9.9.9) is used
 * as server because it seems to take privacy of users serious. Other servers can
 * be found at https://en.wikipedia.org/wiki/Public_recursive_name_server
 */

function SocketPlugin() {
  "use strict";

  var DEBUG = 0; // 0 = off, 1 = some, 2 = more, 3 = lots

  const CROQUET_URL = "https://cdn.jsdelivr.net/npm/@croquet/croquet@1.1.0-41";

  // The embedded API key is restricted to codefrau.github.io
  // get your own key from https://croquet.io/keys
  // to run this locally I use the URL
  // http://localhost:8000/jasmine/?apiKey=<my-dev-key>
  // where <my-dev-key> is an unrestricted key
  const CROQUET_APIKEY = "1bfHo0sk3HLmzqxiaasuEFBccxNDE660vMzghymFm";
  const CROQUET_APPID = "net.codefrau.squeakjs"; // can be anything
  const CROQUET_SESSION = "10.42.0.0"; // network as session name because why not
  const CROQUET_PASSWORD = "none"; // make everyone join the same session

  // we use the 10.42.0.0/16 subnet, giving us 65535 IP addresses
  const CROQUET_NETWORK = CROQUET_SESSION.split(".").map(d => +d);
  const BROADCAST_ADDR = "255.255.255.255"; // technically it's 10.42.255.255
  const CROQUET_RELEASE_HOSTNAME = 1000 * 60 * 60 * 24; // 24 hours
  const CROQUET_RATE_LIMIT = 1000 / 20; // if we send too often, Croquet will kick us out
  const CROQUET_MTU = 1500; // Croquet messages are soft-limited to 4k, but we need to account for BASE64 encoding and headers
  const CROQUET_MMS = CROQUET_MTU - 100; // maximum message size (MMS) is MTU minus headers

  const IP_HEADER = 2 * 4 + 1; // 2 addresses (4 bytes each) + protocol (1 byte)
  const UDP_HEADER = IP_HEADER + 2 * 2; // 2 ports (2 bytes each)
  const TCP_HEADER = IP_HEADER + 2 * 2 + 2 * 4 + 1 + 2; // 2 ports (2 bytes each) + seq/ack (4 bytes each) + flags (1 byte) + window (2 bytes)

  const TCP_RST = 0x01;  // no need to use real TCP flag values
  const TCP_SYN = 0x02;
  const TCP_FIN = 0x04;
  const TCP_ACK = 0x08;
  const TCP_MSL = 60 * 1000; // 60 seconds (maximum segment lifetime)

  // wrap-around 32 bit math for sequence numbers
  function seqNum(a) { return a >>> 0; } // convert to unsigned
  function seqLE(a, b) { return ((b - a) | 0) >= 0; }
  function seqLT(a, b) { return ((b - a) | 0) > 0; }
  function seqGE(a, b) { return ((b - a) | 0) <= 0; }
  function seqGT(a, b) { return ((b - a) | 0) < 0; }

  return {
    getModuleName: function () { return 'SocketPlugin (croquet.io)'; },
    interpreterProxy: null,
    primHandler: null,

    handleCounter: 0,
    needProxy: new Set(),

    // DNS Lookup
    // Cache elements: key is name, value is { address: 1.2.3.4, validUntil: Date.now() + 30000 }
    status: 0, // Resolver_Uninitialized,
    lookupCache: {
      localhost: { address: [127, 0, 0, 1], validUntil: Number.MAX_SAFE_INTEGER }
    },
    lastLookup: null,
    lookupSemaIdx: 0,

    // allocated network ports for croquet network sockets (portNumber => socket)
    croquetTCPPorts: {},
    croquetTCPNextPort: 49152, // 49152 - 65535 (IANA suggested range for dynamic or private ports)
    croquetUDPPorts: {},
    croquetUDPNextPort: 49152, // 49152 - 65535

    // Constants
    Domain_Unspecified: 0,
    Domain_local: 1,
    Domain_IPv4: 2,
    Domain_IPv6: 3,
    TCP_Socket_Type: 0,
    UDP_Socket_Type: 1,
    Resolver_Uninitialized: 0,
    Resolver_Ready: 1,
    Resolver_Busy: 2,
    Resolver_Error: 3,
    Socket_InvalidSocket: -1,
    Socket_Unconnected: 0,
    Socket_WaitingForConnection: 1,
    Socket_Connected: 2,
    Socket_OtherEndClosed: 3,
    Socket_ThisEndClosed: 4,

    setInterpreter: function (anInterpreter) {
      this.interpreterProxy = anInterpreter;
      this.vm = anInterpreter.vm;
      this.primHandler = this.vm.primHandler;
      return true;
    },

    _signalSemaphore: function (semaIndex) {
      if (semaIndex <= 0) return;
      this.primHandler.signalSemaphoreWithIndex(semaIndex);
    },

    _signalLookupSemaphore: function () { this._signalSemaphore(this.lookupSemaIdx); },

    _getAddressFromLookupCache: function (name, skipExpirationCheck) {
      if (name) {

        // Check for valid dotted decimal name first
        var dottedDecimalsMatch = name.match(/^\d+\.\d+\.\d+\.\d+$/);
        if (dottedDecimalsMatch) {
          var result = name.split(".").map(function (d) { return +d; });
          if (result.every(function (d) { return d <= 255; })) {
            return new Uint8Array(result);
          }
        }

        // Lookup in cache
        var cacheEntry = this.lookupCache[name];
        if (cacheEntry && (skipExpirationCheck || cacheEntry.validUntil >= Date.now())) {
          return new Uint8Array(cacheEntry.address);
        }
      }
      return null;
    },

    _addAddressFromResponseToLookupCache: function (response) {
      // Check for valid response
      if (!response || response.Status !== 0 || !response.Question || !response.Answer) {
        return;
      }

      // Clean up all response elements by removing trailing dots in names
      var removeTrailingDot = function (element, field) {
        if (element[field] && element[field].replace) {
          element[field] = element[field].replace(/\.$/, "");
        }
      };
      var originalQuestion = response.Question[0];
      removeTrailingDot(originalQuestion, "name");
      response.Answer.forEach(function (answer) {
        removeTrailingDot(answer, "name");
        removeTrailingDot(answer, "data");
      });

      // Get address by traversing alias chain
      var lookup = originalQuestion.name;
      var address = null;
      var ttl = 24 * 60 * 60; // One day as safe default
      var hasAddress = response.Answer.some(function (answer) {
        if (answer.name === lookup) {

          // Time To Live can be set on alias and address, keep shortest period
          if (answer.TTL) {
            ttl = Math.min(ttl, answer.TTL);
          }

          if (answer.type === 1) {
            // Retrieve IP address as array with 4 numeric values
            address = answer.data.split(".").map(function (numberString) { return +numberString; });
            return true;
          } else if (answer.type === 5) {
            // Lookup name points to alias, follow alias from here on
            lookup = answer.data;
          }
        }
        return false;
      });

      // Store address found
      if (hasAddress) {
        DEBUG > 2 && console.log("DNS lookup for " + originalQuestion.name + " found " + address.join(".") + " (TTL " + ttl + ")");
        this.lookupCache[originalQuestion.name] = { address: address, validUntil: Date.now() + (ttl * 1000) };
      }
    },

    _compareAddresses: function (address1, address2) {
      return address1.every(function (addressPart, index) {
        return address2[index] === addressPart;
      });
    },

    _reverseLookupNameForAddress: function (address) {
      // Currently public API's for IP to hostname are not standardized yet (like DoH).
      // Assume most lookup's will be for reversing earlier name to address lookups.
      // Therefor use the lookup cache and otherwise create a dotted decimals name.
      var result = null;
      Object.keys(this.lookupCache).some(function (name) {
        if (this._compareAddresses(address, this.lookupCache[name].address)) {
          result = name;
          return true;
        }
        return false;
      }.bind(this));
      return result || address.join(".");
    },

    // A socket emulates socket behavior
    _newSocket: function (domain, socketType, recvBufSize, sendBufSize, connSemaIdx, readSemaIdx, writeSemaIdx) {
      var plugin = this;
      return {
        domain: domain,
        type: socketType,
        hostAddress: null,
        host: null,
        port: null,

        connSemaIndex: connSemaIdx,
        readSemaIndex: readSemaIdx,
        writeSemaIndex: writeSemaIdx,

        webSocket: null,

        isCroquet: false,
        localPort: null, // only for croquet sockets (maybe should generalize this to all sockets?)
        listening: false, // ready to receive a connection (TCP) or data (UDP)
        recvBufSize: recvBufSize, // buffers are unused for http and ws requests
        sendBufSize: sendBufSize, // but are used for TCP flow control in Croquet sockets

        sendBuffer: null,
        sendTimeout: null,

        response: null,
        responseReadUntil: 0,
        responseReceived: false,

        status: plugin.Socket_Unconnected,

        _signalConnSemaphore: function () { plugin._signalSemaphore(this.connSemaIndex); DEBUG > 2 && console.log("Signaled conn semaphore: " + this); },
        _signalReadSemaphore: function () { plugin._signalSemaphore(this.readSemaIndex); DEBUG > 2 && console.log("Signaled read semaphore: " + this); },
        _signalWriteSemaphore: function () { plugin._signalSemaphore(this.writeSemaIndex); DEBUG > 2 && console.log("Signaled write semaphore: " + this); },

        _otherEndClosed: function () {
          this.status = plugin.Socket_OtherEndClosed;
          this.webSocket = null;
          this._signalConnSemaphore();
        },

        _hostAndPort: function () { return this.host + ':' + this.port; },

        _requestNeedsProxy: function () {
          return plugin.needProxy.has(this._hostAndPort());
        },

        _getURL: function (targetURL, isRetry) {
          var url = '';
          if (isRetry || this._requestNeedsProxy()) {
            var proxy = typeof SqueakJS === "object" && SqueakJS.options.proxy;
            url = proxy || 'https://corsproxy.io/?';
          }
          if (this.port !== 443) {
            url += 'http://' + this._hostAndPort() + targetURL;
          } else {
            url += 'https://' + this.host + targetURL;
          }
          return url;
        },

        _performRequest: function () {
          // Assume a send is requested through WebSocket if connection is present
          if (this.webSocket) {
            this._performWebSocketSend();
            return;
          }

          var request = new TextDecoder("utf-8").decode(this.sendBuffer);

          // Remove request from send buffer
          var endOfRequestIndex = this.sendBuffer.findIndex(function (element, index, array) {
            // Check for presence of "\r\n\r\n" denoting the end of the request (do simplistic but fast check)
            return array[index] === "\r" && array[index + 2] === "\r" && array[index + 1] === "\n" && array[index + 3] === "\n";
          });
          if (endOfRequestIndex >= 0) {
            this.sendBuffer = this.sendBuffer.subarray(endOfRequestIndex + 4);
          } else {
            this.sendBuffer = null;
          }

          // Extract header fields
          var headerLines = request.split('\r\n\r\n')[0].split('\n');
          // Split header lines and parse first line
          var firstHeaderLineItems = headerLines[0].split(' ');
          var httpMethod = firstHeaderLineItems[0];
          if (httpMethod !== 'GET' && httpMethod !== 'PUT' &&
            httpMethod !== 'POST') {
            this._otherEndClosed();
            return -1;
          }
          var targetURL = firstHeaderLineItems[1];

          // Extract possible data to send
          var seenUpgrade = false;
          var seenWebSocket = false;
          var data = null;
          for (var i = 1; i < headerLines.length; i++) {
            var line = headerLines[i];
            if (line.match(/Content-Length:/i)) {
              var contentLength = parseInt(line.substr(16));
              var end = this.sendBuffer.byteLength;
              data = this.sendBuffer.subarray(end - contentLength, end);
            } else if (line.match(/Host:/i)) {
              var hostAndPort = line.substr(6).trim();
              var host = hostAndPort.split(':')[0];
              var port = parseInt(hostAndPort.split(':')[1]) || this.port;
              if (this.host !== host) {
                console.warn('Host for ' + this.hostAddress + ' was ' + this.host + ' but from HTTP request now ' + host);
                this.host = host;
              }
              if (this.port !== port) {
                console.warn('Port for ' + this.hostAddress + ' was ' + this.port + ' but from HTTP request now ' + port);
                this.port = port;
              }
            } if (line.match(/Connection: Upgrade/i)) {
              seenUpgrade = true;
            } else if (line.match(/Upgrade: WebSocket/i)) {
              seenWebSocket = true;
            }
          }

          if (httpMethod === "GET" && seenUpgrade && seenWebSocket) {
            this._performWebSocketRequest(targetURL, httpMethod, data, headerLines);
          } else if (self.fetch) {
            this._performFetchAPIRequest(targetURL, httpMethod, data, headerLines);
          } else {
            this._performXMLHTTPRequest(targetURL, httpMethod, data, headerLines);
          }
        },

        _performFetchAPIRequest: function (targetURL, httpMethod, data, requestLines) {
          var thisSocket = this;
          var headers = {};
          for (var i = 1; i < requestLines.length; i++) {
            var lineItems = requestLines[i].split(':');
            if (lineItems.length === 2) {
              headers[lineItems[0]] = lineItems[1].trim();
            }
          }
          if (typeof SqueakJS === "object" && SqueakJS.options.ajax) {
            headers["X-Requested-With"] = "XMLHttpRequest";
          }
          var init = {
            method: httpMethod,
            headers: headers,
            body: data,
            mode: 'cors'
          };

          fetch(this._getURL(targetURL), init)
            .then(thisSocket._handleFetchAPIResponse.bind(thisSocket))
            .catch(function (e) {
              var url = thisSocket._getURL(targetURL, true);
              console.warn('Retrying with CORS proxy: ' + url);
              fetch(url, init)
                .then(function (res) {
                  console.log('Success: ' + url);
                  thisSocket._handleFetchAPIResponse(res);
                  plugin.needProxy.add(thisSocket._hostAndPort());
                })
                .catch(function (e) {
                  // KLUDGE! This is just a workaround for a broken
                  // proxy server - we should remove it when
                  // crossorigin.me is fixed
                  console.warn('Fetch API failed, retrying with XMLHttpRequest');
                  thisSocket._performXMLHTTPRequest(targetURL, httpMethod, data, requestLines);
                });
            });
        },

        _handleFetchAPIResponse: function (res) {
          if (this.response === null) {
            var header = ['HTTP/1.0 ', res.status, ' ', res.statusText, '\r\n'];
            res.headers.forEach(function (value, key, array) {
              header = header.concat([key, ': ', value, '\r\n']);
            });
            header.push('\r\n');
            this.response = [new TextEncoder('utf-8').encode(header.join(''))];
          }
          this._readIncremental(res.body.getReader());
        },

        _readIncremental: function (reader) {
          var thisSocket = this;
          return reader.read().then(function (result) {
            if (result.done) {
              thisSocket.responseReceived = true;
              return;
            }
            thisSocket.response.push(result.value);
            thisSocket._signalReadSemaphore();
            return thisSocket._readIncremental(reader);
          });
        },

        _performXMLHTTPRequest: function (targetURL, httpMethod, data, requestLines) {
          var thisSocket = this;

          var contentType;
          for (var i = 1; i < requestLines.length; i++) {
            var line = requestLines[i];
            if (line.match(/Content-Type:/i)) {
              contentType = encodeURIComponent(line.substr(14));
              break;
            }
          }

          var httpRequest = new XMLHttpRequest();
          httpRequest.open(httpMethod, this._getURL(targetURL));
          if (contentType !== undefined) {
            httpRequest.setRequestHeader('Content-type', contentType);
          }
          if (typeof SqueakJS === "object" && SqueakJS.options.ajax) {
            httpRequest.setRequestHeader("X-Requested-With", "XMLHttpRequest");
          }

          httpRequest.responseType = "arraybuffer";

          httpRequest.onload = function (oEvent) {
            thisSocket._handleXMLHTTPResponse(this);
          };

          httpRequest.onerror = function (e) {
            var url = thisSocket._getURL(targetURL, true);
            console.warn('Retrying with CORS proxy: ' + url);
            var retry = new XMLHttpRequest();
            retry.open(httpMethod, url);
            retry.responseType = httpRequest.responseType;
            if (typeof SqueakJS === "object" && SqueakJS.options.ajaxx) {
              retry.setRequestHeader("X-Requested-With", "XMLHttpRequest");
            }
            retry.onload = function (oEvent) {
              console.log('Success: ' + url);
              thisSocket._handleXMLHTTPResponse(this);
              plugin.needProxy.add(thisSocket._hostAndPort());
            };
            retry.onerror = function () {
              thisSocket._otherEndClosed();
              console.error("Failed to download:\n" + url);
            };
            retry.send(data);
          };

          httpRequest.send(data);
        },

        _handleXMLHTTPResponse: function (response) {
          this.responseReceived = true;

          var content = response.response;
          if (!content) {
            this._otherEndClosed();
            return;
          }
          // Recreate header
          var header = new TextEncoder('utf-8').encode(
            'HTTP/1.0 ' + response.status + ' ' + response.statusText +
            '\r\n' + response.getAllResponseHeaders() + '\r\n');
          // Concat header and response
          var res = new Uint8Array(header.byteLength + content.byteLength);
          res.set(header, 0);
          res.set(new Uint8Array(content), header.byteLength);

          this.response = [res];
          this._signalReadSemaphore();
        },

        _performWebSocketRequest: function (targetURL, httpMethod, data, requestLines) {
          var url = this._getURL(targetURL);

          // Extract WebSocket key and subprotocol
          var webSocketSubProtocol;
          var webSocketKey;
          for (var i = 1; i < requestLines.length; i++) {
            var requestLine = requestLines[i].split(":");
            if (requestLine[0] === "Sec-WebSocket-Protocol") {
              webSocketSubProtocol = requestLine[1].trim();
              if (webSocketKey) {
                break;  // Only break if both webSocketSubProtocol and webSocketKey are found
              }
            } else if (requestLine[0] === "Sec-WebSocket-Key") {
              webSocketKey = requestLine[1].trim();
              if (webSocketSubProtocol) {
                break;  // Only break if both webSocketSubProtocol and webSocketKey are found
              }
            }
          }

          // Keep track of WebSocket for future send and receive operations
          this.webSocket = new WebSocket(url.replace(/^http/, "ws"), webSocketSubProtocol);

          var thisSocket = this;
          this.webSocket.onopen = function () {
            if (thisSocket.status !== plugin.Socket_Connected) {
              thisSocket.status = plugin.Socket_Connected;
              thisSocket._signalConnSemaphore();
              thisSocket._signalWriteSemaphore(); // Immediately ready to write
            }

            // Send the (fake) handshake back to the caller
            var acceptKey = new Uint8Array(sha1.array(webSocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            var acceptKeyString = Squeak.bytesAsString(acceptKey);
            thisSocket._performWebSocketReceive(
              "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Accept: " + btoa(acceptKeyString) + "\r\n\r\n",
              true,
            );
          };
          this.webSocket.onmessage = function (event) {
            thisSocket._performWebSocketReceive(event.data);
          };
          this.webSocket.onerror = function (e) {
            thisSocket._otherEndClosed();
            console.error("Error in WebSocket:", e);
          };
          this.webSocket.onclose = function () {
            thisSocket._otherEndClosed();
          };
        },

        _performWebSocketReceive: function (message, skipFramePacking) {

          // Process received message
          var dataIsBinary = !message.substr;
          if (!dataIsBinary) {
            message = new TextEncoder("utf-8").encode(message);
          }
          if (!skipFramePacking) {

            // Create WebSocket frame from message for Smalltalk runtime
            var frameLength = 1 + 1 + message.length + 4; // 1 byte for initial header bits & opcode, 1 byte for length and 4 bytes for mask
            var payloadLengthByte;
            if (message.byteLength < 126) {
              payloadLengthByte = message.length;
            } else if (message.byteLength < 0xffff) {
              frameLength += 2; // 2 additional bytes for payload length
              payloadLengthByte = 126;
            } else {
              frameLength += 8; // 8 additional bytes for payload length
              payloadLengthByte = 127;
            }
            var frame = new Uint8Array(frameLength);
            frame[0] = dataIsBinary ? 0x82 : 0x81;  // Final bit 0x80 set and opcode 0x01 for text and 0x02 for binary
            frame[1] = 0x80 | payloadLengthByte;  // Mask bit 0x80 and payload length byte
            var nextByteIndex;
            if (payloadLengthByte === 126) {
              frame[2] = message.length >>> 8;
              frame[3] = message.length & 0xff;
              nextByteIndex = 4;
            } else if (payloadLengthByte === 127) {
              frame[2] = message.length >>> 56;
              frame[3] = (message.length >>> 48) & 0xff;
              frame[4] = (message.length >>> 40) & 0xff;
              frame[5] = (message.length >>> 32) & 0xff;
              frame[6] = (message.length >>> 24) & 0xff;
              frame[7] = (message.length >>> 16) & 0xff;
              frame[8] = (message.length >>> 8) & 0xff;
              frame[9] = message.length & 0xff;
              nextByteIndex = 10;
            } else {
              nextByteIndex = 2;
            }

            // Add 'empty' mask (requiring no transformation)
            // Otherwise a (random) mask and the following line should be added:
            // var payload = message.map(function(b, index) { return b ^ maskKey[index & 0x03]; });
            var maskKey = new Uint8Array(4);
            frame.set(maskKey, nextByteIndex);
            nextByteIndex += 4;
            var payload = message;
            frame.set(payload, nextByteIndex);

            // Make sure the frame is set as the response
            message = frame;
          }

          // Store received message in response buffer
          if (!this.response || !this.response.length) {
            this.response = [message];
          } else {
            this.response.push(message);
          }
          this.responseReceived = true;
          this._signalReadSemaphore();
        },

        _performWebSocketSend: function () {
          // Decode sendBuffer which is a WebSocket frame (from Smalltalk runtime)

          // Read frame header fields
          var firstByte = this.sendBuffer[0];
          var finalBit = firstByte >>> 7;
          var opcode = firstByte & 0x0f;
          var dataIsBinary;
          if (opcode === 0x00) {
            // Continuation frame
            console.error("No support for WebSocket frame continuation yet!");
            return true;
          } else if (opcode === 0x01) {
            // Text frame
            dataIsBinary = false;
          } else if (opcode === 0x02) {
            // Binary frame
            dataIsBinary = true;
          } else if (opcode === 0x08) {
            // Close connection
            this.webSocket.close();
            this.webSocket = null;
            return;
          } else if (opcode === 0x09 || opcode === 0x0a) {
            // Ping/pong frame (ignoring it, is handled by WebSocket implementation itself)
            return;
          } else {
            console.error("Unsupported WebSocket frame opcode " + opcode);
            return;
          }
          var secondByte = this.sendBuffer[1];
          var maskBit = secondByte >>> 7;
          var payloadLength = secondByte & 0x7f;
          var nextByteIndex;
          if (payloadLength === 126) {
            payloadLength = (this.sendBuffer[2] << 8) | this.sendBuffer[3];
            nextByteIndex = 4;
          } else if (payloadLength === 127) {
            payloadLength =
              (this.sendBuffer[2] << 56) |
              (this.sendBuffer[3] << 48) |
              (this.sendBuffer[4] << 40) |
              (this.sendBuffer[5] << 32) |
              (this.sendBuffer[6] << 24) |
              (this.sendBuffer[7] << 16) |
              (this.sendBuffer[8] << 8) |
              this.sendBuffer[9]
              ;
            nextByteIndex = 10;
          } else {
            nextByteIndex = 2;
          }
          var maskKey;
          if (maskBit) {
            maskKey = this.sendBuffer.subarray(nextByteIndex, nextByteIndex + 4);
            nextByteIndex += 4;
          }

          // Read (remaining) payload
          var payloadData = this.sendBuffer.subarray(nextByteIndex, nextByteIndex + payloadLength);
          nextByteIndex += payloadLength;

          // Unmask the payload
          if (maskBit) {
            payloadData = payloadData.map(function (b, index) { return b ^ maskKey[index & 0x03]; });
          }

          // Extract data from payload
          var data;
          if (dataIsBinary) {
            data = payloadData;
          } else {
            data = Squeak.bytesAsString(payloadData);
          }

          // Remove frame from send buffer
          this.sendBuffer = this.sendBuffer.subarray(nextByteIndex);
          this.webSocket.send(data);

          // Send remaining frames
          if (this.sendBuffer.byteLength > 0) {
            this._performWebSocketSend();
          }
        },

        connect: function (hostAddress, port) {
          // check if we're connecting to the Croquet subnet otherwise assume it's http
          var isCroquetAddress = hostAddress[0] === CROQUET_NETWORK[0] && hostAddress[1] === CROQUET_NETWORK[1];
          if (isCroquetAddress) {
              plugin.croquetConnect(this, hostAddress, port);
          } else {
            this.hostAddress = hostAddress;
            this.host = plugin._reverseLookupNameForAddress(hostAddress);
            this.port = port;
            this.status = plugin.Socket_Connected;
            this._signalConnSemaphore();
            this._signalWriteSemaphore(); // Immediately ready to write
          }
        },

        close: function () {
          if (this.status == plugin.Socket_Connected ||
            this.status == plugin.Socket_OtherEndClosed ||
            this.status == plugin.Socket_WaitingForConnection) {
            if (this.webSocket) {
              this.webSocket.close();
              this.webSocket = null;
            }
            if (this.isCroquet) {
              plugin.croquetClose(this);
            }
            this.status = plugin.Socket_Unconnected;
            this._signalConnSemaphore();
          }
        },

        destroy: function () {
          if (this.localPort) {
            plugin.croquetDestroy(this);
          }
          this.status = plugin.Socket_InvalidSocket;
        },

        dataAvailable: function () {
          if (this.status == plugin.Socket_InvalidSocket) return false;
          if (this.status == plugin.Socket_Connected) {
            if (this.webSocket) {
              return this.response && this.response.length > 0;
            } else {
              if (this.response && this.response.length > 0) {
                this._signalReadSemaphore();
                return true;
              }
              if (this.responseSentCompletly) {
                // Signal older Socket implementations that they reached the end
                this.status = plugin.Socket_OtherEndClosed;
                this._signalConnSemaphore();
              }
            }
          }
          return false;
        },

        recv: function (count) {
          if (this.type == plugin.TCP_Socket_Type) {
            return plugin.tcpRECEIVE(this, count);
          }
          if (this.response === null) return [];
          var data = this.response[0];
          if (data.length > count) {
            var rest = data.subarray(count);
            if (rest) {
              this.response[0] = rest;
            } else {
              this.response.shift();
            }
            data = data.subarray(0, count);
          } else {
            this.response.shift();
          }
          if (this.responseReceived && this.response.length === 0 && !this.webSocket && !this.isCroquet) {
            this.responseSentCompletly = true;
          }

          return data;
        },

        send: function (data, start, end) {
          var newBytes = data.bytes.subarray(start, end);
          if (this.isCroquet) {
            return this.type === plugin.TCP_Socket_Type
              ? plugin.tcpSEND(this, newBytes)
              : plugin.udpSend(this, newBytes);
          }
          if (this.sendTimeout !== null) {
            self.clearTimeout(this.sendTimeout);
          }
          this.lastSend = Date.now();
          if (this.sendBuffer === null) {
            // Make copy of buffer otherwise the stream buffer will overwrite it on next call (inside Smalltalk image)
            this.sendBuffer = newBytes.slice();
          } else {
            var newLength = this.sendBuffer.byteLength + newBytes.byteLength;
            var newBuffer = new Uint8Array(newLength);
            newBuffer.set(this.sendBuffer, 0);
            newBuffer.set(newBytes, this.sendBuffer.byteLength);
            this.sendBuffer = newBuffer;
          }
          // Give image some time to send more data before performing requests
          this.sendTimeout = self.setTimeout(this._performRequest.bind(this), 50);
          return newBytes.byteLength;
        },

        [Symbol.toPrimitive]: function () {
          var name = this.name || "socket";
          var details = "";
          if (this.isCroquet) details += " Croquet";
          if (this.type === plugin.TCP_Socket_Type) details += " tcp";
          else if (this.type === plugin.UDP_Socket_Type) details += " udp";
          if (this.localPort) details += ":" + this.localPort;
          if (this.port) details += " remote: " + (this.host || this.hostAddress.join(".")) + ":" + this.port;
          details += " (" + this.statusString() + ")";
          return name + "[" + details.trim() + "]";
        },

        statusString: function () {
          switch (this.status) {
            case plugin.Socket_InvalidSocket: return 'invalid';
            case plugin.Socket_Unconnected: return 'unconnected';
            case plugin.Socket_WaitingForConnection: return 'waiting for connection';
            case plugin.Socket_Connected: return 'connected';
            case plugin.Socket_OtherEndClosed: return 'other end closed';
            case plugin.Socket_ThisEndClosed: return 'this end closed';
            default: return 'unknown ' + this.status;
          }
        }
      };
    },

    primitiveHasSocketAccess: function (argCount) {
      DEBUG > 1 && console.log("primitiveHasSocketAccess");
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.trueObject());
      return true;
    },

    primitiveInitializeNetwork: function (argCount) {
      DEBUG > 1 && console.log("primitiveInitializeNetwork");
      if (argCount !== 1) return false;
      this.lookupSemaIdx = this.interpreterProxy.stackIntegerValue(0);
      this.status = this.Resolver_Ready;
      this.interpreterProxy.pop(argCount); // Answer self
      return true;
    },

    primitiveResolverNameLookupResult: function (argCount) {
      if (argCount !== 0) return false;
      var result = this.interpreterProxy.nilObject(); // Answer nil if no lookup was started
      // Validate that lastLookup is in fact a name (and not an address)
      if (typeof this.lastLookup === "string") {
        // Retrieve result from cache
        var address = this._getAddressFromLookupCache(this.lastLookup, true);
        if (address) result = this.primHandler.makeStByteArray(address);
      }
      DEBUG > 1 && console.log("primitiveResolverNameLookupResult => " + result);
      this.interpreterProxy.popthenPush(argCount + 1, result);
      return true;
    },

    primitiveResolverStartNameLookup: function (argCount) {
      if (argCount !== 1) return false;

      // Start new lookup, ignoring if one is in progress
      var lookup = this.lastLookup = this.interpreterProxy.stackValue(0).bytesAsString();

      DEBUG > 1 && console.log("primitiveResolverStartNameLookup " + lookup);

      // Perform lookup in local cache
      var result = this._getAddressFromLookupCache(lookup, false);
      if (result) {
        this.status = this.Resolver_Ready;
        this._signalLookupSemaphore();
      } else {

        // Perform DNS request
        var dnsQueryURL = "https://9.9.9.9:5053/dns-query?name=" + encodeURIComponent(this.lastLookup) + "&type=A";
        var queryStarted = false;
        DEBUG > 2 && console.log("DNS query: " + dnsQueryURL);
        if (self.fetch) {
          var thisSocket = this;
          var init = {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            cache: "no-store", // do not use the browser cache for DNS requests (a separate cache is kept)
            referrer: "no-referrer",
            referrerPolicy: "no-referrer",
          };
          self.fetch(dnsQueryURL, init)
            .then(function (response) {
              return response.json();
            })
            .then(function (response) {
              thisSocket._addAddressFromResponseToLookupCache(response);
            })
            .catch(function (error) {
              console.error("Name lookup failed", error);
            })
            .then(function () {

              // If no other lookup is started, signal the receiver (ie resolver) is ready
              if (lookup === thisSocket.lastLookup) {
                thisSocket.status = thisSocket.Resolver_Ready;
                thisSocket._signalLookupSemaphore();
              }
            })
            ;
          queryStarted = true;
        } else {
          var thisSocket = this;
          var lookupReady = function () {

            // If no other lookup is started, signal the receiver (ie resolver) is ready
            if (lookup === thisSocket.lastLookup) {
              thisSocket.status = thisSocket.Resolver_Ready;
              thisSocket._signalLookupSemaphore();
            }
          };
          var httpRequest = new XMLHttpRequest();
          httpRequest.open("GET", dnsQueryURL, true);
          httpRequest.timeout = 2000; // milliseconds
          httpRequest.responseType = "json";
          httpRequest.onload = function (oEvent) {
            thisSocket._addAddressFromResponseToLookupCache(this.response);
            lookupReady();
          };
          httpRequest.onerror = function () {
            console.error("Name lookup failed", httpRequest.statusText);
            lookupReady();
          };
          httpRequest.send();

          queryStarted = true;
        }

        // Mark the receiver (ie resolver) is busy
        if (queryStarted) {
          this.status = this.Resolver_Busy;
          this._signalLookupSemaphore();
        }
      }

      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    primitiveResolverAddressLookupResult: function (argCount) {
      DEBUG > 1 && console.log("primitiveResolverAddressLookupResult");
      if (argCount !== 0) return false;

      // Validate that lastLookup is in fact an address (and not a name)
      if (!this.lastLookup || !this.lastLookup.every) {
        this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
        return true;
      }

      // Retrieve result from cache
      var name = this._reverseLookupNameForAddress(this.lastLookup);
      var result = this.primHandler.makeStString(name);
      this.interpreterProxy.popthenPush(argCount + 1, result);
      return true;
    },

    primitiveResolverStartAddressLookup: function (argCount) {
      DEBUG > 1 && console.log("primitiveResolverStartAddressLookup");
      if (argCount !== 1) return false;

      // Start new lookup, ignoring if one is in progress
      this.lastLookup = this.interpreterProxy.stackBytes(0);
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());

      // Immediately signal the lookup is ready (since all lookups are done internally)
      this.status = this.Resolver_Ready;
      this._signalLookupSemaphore();

      return true;
    },

    resolverStatusString: function () {
      switch (this.status) {
        case this.Resolver_Uninitialized: return 'uninitialized';
        case this.Resolver_Ready: return 'ready';
        case this.Resolver_Busy: return 'busy';
        case this.Resolver_Error: return 'error';
        default: return 'unknown ' + this.status;
      }
    },

    primitiveResolverStatus: function (argCount) {
      if (argCount !== 0) return false;
      DEBUG > 1 && console.log("primitiveResolverStatus => " + this.resolverStatusString());
      this.interpreterProxy.popthenPush(argCount + 1, this.status);
      return true;
    },

    primitiveResolverAbortLookup: function (argCount) {
      DEBUG > 1 && console.log("primitiveResolverAbortLookup");
      if (argCount !== 0) return false;

      // Unable to abort send request (although future browsers might support AbortController),
      // just cancel the handling of the request by resetting the lastLookup value
      this.lastLookup = null;
      this.status = this.Resolver_Ready;
      this._signalLookupSemaphore();

      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    primitiveSocketRemoteAddress: function (argCount) {
      DEBUG > 1 && console.log("primitiveSocketRemoteAddress");
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      this.interpreterProxy.popthenPush(argCount + 1, socket.hostAddress ?
        this.primHandler.makeStByteArray(socket.hostAddress) :
        this.interpreterProxy.nilObject()
      );
      return true;
    },

    primitiveSocketRemotePort: function (argCount) {
      DEBUG > 1 && console.log("primitiveSocketRemotePort");
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      this.interpreterProxy.popthenPush(argCount + 1, socket.port);
      return true;
    },

    primitiveSocketConnectionStatus: function (argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      var status = socket.status;
      if (status === undefined) status = this.Socket_InvalidSocket;
      DEBUG > 2 && console.log("primitiveSocketConnectionStatus " + socket);
      this.interpreterProxy.popthenPush(argCount + 1, status);
      return true;
    },

    primitiveSocketConnectToPort: function (argCount) {
      if (argCount !== 3) return false;
      var socket = this.interpreterProxy.stackObjectValue(2).socket;
      if (socket === undefined) return false;
      var hostAddress = this.interpreterProxy.stackBytes(1);
      var port = this.interpreterProxy.stackIntegerValue(0);
      DEBUG > 1 && console.log("primitiveSocketConnectToPort " + socket + " " + hostAddress.join(".") + ":" + port + " ...");
      socket.connect(hostAddress, port);
      DEBUG > 1 && console.log("primitiveSocketConnectToPort " + socket);
      this.interpreterProxy.popthenPush(argCount + 1,
        this.interpreterProxy.nilObject());
      return true;
    },

    primitiveSocketCloseConnection: function (argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      DEBUG > 1 && console.log("primitiveSocketCloseConnection " + socket);
      socket.close();
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    socketCreate: function (domain, socketType, recvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex) {
      if (domain.isNil) domain = this.Domain_IPv4;
      if (domain !== this.Domain_IPv4) return false;
      var name = '{SqueakJS Socket #' + (++this.handleCounter) + '}';
      var sqHandle = this.primHandler.makeStString(name);
      var socket = this._newSocket(domain, socketType, recvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      socket.name = "socket#" + this.handleCounter;
      sqHandle.socket = socket;
      return sqHandle;
    },

    primitiveSocketCreate: function (argCount) {
      // older version of primitiveSocketCreate3Semaphores that is
      // invoked if that primitve failed
      if (argCount !== 5) return false;
      var domain = this.interpreterProxy.stackObjectValue(4);
      var socketType = this.interpreterProxy.stackIntegerValue(3);
      var recvBufSize = this.interpreterProxy.stackIntegerValue(2);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(1);
      var semaIndex = this.interpreterProxy.stackIntegerValue(0);
      var sqHandle = this.socketCreate(domain, socketType, recvBufSize, sendBufSize, semaIndex, semaIndex, semaIndex);
      DEBUG > 1 && console.log("primitiveSocketCreate => " + sqHandle);
      if (!sqHandle) return false;
      this.interpreterProxy.popthenPush(argCount + 1, sqHandle);
    },

    primitiveSocketCreate3Semaphores: function (argCount) {
      if (argCount !== 7) return false;
      var domain = this.interpreterProxy.stackObjectValue(6);
      var socketType = this.interpreterProxy.stackIntegerValue(5);
      var recvBufSize = this.interpreterProxy.stackIntegerValue(4);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(3);
      var semaIndex = this.interpreterProxy.stackIntegerValue(2);
      var readSemaIndex = this.interpreterProxy.stackIntegerValue(1);
      var writeSemaIndex = this.interpreterProxy.stackIntegerValue(0);
      var sqHandle = this.socketCreate(domain, socketType, recvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      DEBUG > 1 && console.log("primitiveSocketCreate3Semaphores => " + sqHandle);
      if (!sqHandle) return false;
      this.interpreterProxy.popthenPush(argCount + 1, sqHandle);
      return true;
    },

    primitiveSocketDestroy: function (argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      DEBUG > 1 && console.log("primitiveSocketDestroy " + socket);
      socket.destroy();
      this.interpreterProxy.popthenPush(argCount + 1, socket.status);
      return true;
    },

    noDataAvailableCount: 0,
    noDataAvailableSince: 0,

    primitiveSocketReceiveDataAvailable: function (argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      var dataAvailable = socket.dataAvailable();
      (DEBUG > 2 || (DEBUG > 1 && dataAvailable)) && console.log("primitiveSocketReceiveDataAvailable " + socket + " => " + dataAvailable);
      if (socket.isCroquet) {
        if (dataAvailable) {
          this.noDataAvailableCount = 0;
        } else {
          if (Date.now() - this.noDataAvailableSince > CROQUET_RATE_LIMIT) {
            this.vm.breakNow();
            DEBUG > 2 && console.log("Croquet network: breaking out of VM loop to receive data");
            this.noDataAvailableCount = 0;
          } else {
            this.noDataAvailableCount++;
          }
        }
      }
      this.interpreterProxy.pop(argCount + 1);
      this.interpreterProxy.pushBool(dataAvailable);
      return true;
    },

    primitiveSocketReceiveDataBufCount: function (argCount) {
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var target = this.interpreterProxy.stackObjectValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      var count = this.interpreterProxy.stackIntegerValue(0);
      if ((start + count) > target.bytes.length) return false;
      var bytes = socket.recv(count);
      if (!bytes) {
        DEBUG > 1 && console.log("primitiveSocketReceiveDataBufCount " + socket + " =>  failed");
        return false;
      }
      target.bytes.set(bytes, start);
      DEBUG > 1 && console.log("primitiveSocketReceiveDataBufCount " + socket + " => " + bytes.length + " bytes");
      this.interpreterProxy.popthenPush(argCount + 1, bytes.length);
      return true;
    },

    primitiveSocketSendDataBufCount: function (argCount) {
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var data = this.interpreterProxy.stackObjectValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      if (start < 0) return false;
      var count = this.interpreterProxy.stackIntegerValue(0);
      var end = start + count;
      if (end > data.length) return false;
      DEBUG > 1 && console.log("primitiveSocketSendDataBufCount " + socket + " (" + count + " bytes)");
      var sent = socket.send(data, start, end);
      if (sent < 0) return false;
      this.interpreterProxy.popthenPush(argCount + 1, sent);
      return true;
    },

    primitiveSocketSendDone: function (argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      var done = true;
      if (socket.isCroquet) done = socket.type === this.TCP_Socket_Type
        ? this.tcpSendDone(socket)
        : this.udpSendDone(socket);
      DEBUG > 1 && console.log("primitiveSocketSendDone " + socket + " => " + done);
      this.interpreterProxy.pop(argCount + 1);
      this.interpreterProxy.pushBool(done);
      return true;
    },

    primitiveSocketSendUDPDataBufCount: function (argCount) {
      if (argCount !== 6) return false;
      var socket = this.interpreterProxy.stackObjectValue(5).socket;
      if (socket === undefined) return false;
      var data = this.interpreterProxy.stackObjectValue(4).bytes;
      if (!data) return false;
      var host = this.interpreterProxy.stackObjectValue(3).bytes;
      if (!host || host.length !== 4) return false;
      var port = this.interpreterProxy.stackIntegerValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      if (start < 0) return false;
      var count = this.interpreterProxy.stackIntegerValue(0);
      var end = start + count;
      if (end > data.length) return false;

      DEBUG > 1 && console.log("primitiveSocketSendUDPDataBufCount " + socket + " to " + host.join(".") + ":" + port + " (" + count + " bytes)");

      if (!socket.localPort) {
        this.croquetConnect(socket, host, port);
      }

      if (start > 0 || end - start !== data.length) data = data.subarray(start, end);
      var count = this.udpSend(socket, data);

      this.interpreterProxy.popthenPush(argCount + 1, count);
      return true;
    },

    primitiveSocketReceiveUDPDataBufCount: function (argCount) {
      // primSocket: socketID receiveUDPDataInto: aStringOrByteArray startingAt: startIndex count: count
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var target = this.interpreterProxy.stackObjectValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      var count = this.interpreterProxy.stackIntegerValue(0);
      if ((start + count) > target.bytes.length) return false;

      var responseBefore = socket.response.length;
      var bytes = socket.recv(count);
      if (!bytes) {
        DEBUG > 1 && console.log("primitiveSocketReceiveDataBufCount " + socket + " =>  failed");
        return false;
      }
      target.bytes.set(bytes, start);
      DEBUG > 1 && console.log("primitiveSocketReceiveUDPDataBufCount " + socket + " => " + bytes.length + " bytes");
      var results = this.interpreterProxy.instantiateClassindexableSize(this.interpreterProxy.classArray(), 4);
      var addressOop = this.interpreterProxy.instantiateClassindexableSize(this.interpreterProxy.classByteArray(), 4);
      addressOop.bytes.set(socket.hostAddress);
      var port = socket.port;
      var moreFlag = socket.response.length === responseBefore;
      results.pointers[0] = bytes.length;
      results.pointers[1] = addressOop;
      results.pointers[2] = port;
      results.pointers[3] = moreFlag ? this.vm.trueObj : this.vm.falseObj;
      this.interpreterProxy.popthenPush(argCount + 1, results);
    },

    primitiveSocketListenWithOrWithoutBacklog: function (argCount) {
      if (argCount < 2) return false;
      var socket = this.interpreterProxy.stackObjectValue(argCount - 1).socket;
      if (socket === undefined) return false;
      var port = this.interpreterProxy.stackIntegerValue(argCount - 2);
      if (port < 0 || port > 65535) return false;
      var backlog = 0;
      if (argCount > 2) {
        backlog = this.interpreterProxy.stackIntegerValue(argCount - 3);
      }
      DEBUG > 1 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket, port, backlog, "...");
      if (socket.status !== this.Socket_Unconnected && socket.type !== this.UDP_Socket_Type) {
        console.warn("Croquet network: socket is already connected");
        return false;
      }
      var success = this.croquetListen(socket, port, backlog);
      if (!success) {
        DEBUG > 1 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket + " => failed");
        return false;
      }
      DEBUG > 1 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket + " => success");
      this.interpreterProxy.pop(argCount);
      return true;
    },

    socketAccept: function (socket, recvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex) {
      var srcAndPort = socket.pendingConnections.shift();
      if (socket.pendingConnections.length === 0) {
        socket.status = this.Socket_WaitingForConnection;
      }
      if (!srcAndPort) return false;
      var newSocket = this.socketCreate(socket.domain, socket.type, recvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      if (!newSocket) return false;
      var [src, port] = srcAndPort.split(":"); port = +port;
      this.croquetAccept(socket, newSocket.socket, src, port);
      return newSocket;
    },

    primitiveSocketAccept3Semaphores: function (argCount) {
      if (argCount !== 6) return false;
      var socket = this.interpreterProxy.stackObjectValue(5).socket;
      if (socket === undefined) return false;
      var recvBufSize = this.interpreterProxy.stackIntegerValue(4);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(3);
      var semaIndex = this.interpreterProxy.stackIntegerValue(2);
      var readSemaIndex = this.interpreterProxy.stackIntegerValue(1);
      var writeSemaIndex = this.interpreterProxy.stackIntegerValue(0);
      var newSocket = this.socketAccept(socket, recvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      DEBUG > 1 && console.log("primitiveSocketAccept3Semaphores " + socket + " => " + newSocket.socket);
      if (!newSocket) return false;
      this.interpreterProxy.popthenPush(argCount + 1, newSocket);
      return true;
    },

    primitiveSocketAccept: function (argCount) {
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var recvBufSize = this.interpreterProxy.stackIntegerValue(2);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(1);
      var semaIndex = this.interpreterProxy.stackIntegerValue(0);
      var newSocket = this.socketAccept(socket, recvBufSize, sendBufSize, semaIndex, semaIndex, semaIndex);
      DEBUG > 1 && console.log("primitiveSocketAccept " + socket + " => " + newSocket);
      if (!newSocket) return false;
      this.interpreterProxy.popthenPush(argCount + 1, newSocket);
      return true;
    },

    primitiveSocketLocalPort: function (argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0);
      var socket = socket.socket;
      if (socket === undefined) return false;
      var localPort = socket.localPort || 0;
      DEBUG > 1 && console.log("primitiveSocketLocalPort " + socket + " => " + localPort);
      this.interpreterProxy.popthenPush(argCount + 1, localPort);
    },

    primitiveSocketSetOptions: function (argCount) {
      if (argCount !== 3) return false;
      var socket = this.interpreterProxy.stackObjectValue(2).socket;
      if (socket === undefined) return false;
      var options = this.interpreterProxy.stackObjectValue(1).bytesAsString();
      var value = this.interpreterProxy.stackObjectValue(0).bytesAsString();
      if (options[0] === "'") options = options.slice(1, -1);
      if (value[0] === "'") value = value.slice(1, -1);
      value = +value || 0;
      switch (options) {
        case "SO_BROADCAST":
          socket.broadcast = value;
          DEBUG > 1 && console.log("primitiveSocketSetOptions " + socket + " SO_BROADCAST " + value);
          break;
        default: DEBUG > 0 && console.warn("primitiveSocketSetOptions: unknown option " + options);
      }
      var resultArray = this.interpreterProxy.instantiateClassindexableSize(this.interpreterProxy.classArray(), 2);
      resultArray.pointers[0] = 0;
      resultArray.pointers[1] = 0;
      this.interpreterProxy.popthenPush(argCount + 1, resultArray);
    },

    primitiveResolverLocalAddress: function (argCount) {
      DEBUG > 1 && console.log("primitiveResolverLocalAddress ...");
      if (argCount !== 0) return false;
      var localAddressOop = this.interpreterProxy.instantiateClassindexableSize(this.interpreterProxy.classByteArray(), 4);

      // this call may freeze the VM if there is no network session yet,
      // meaning we execute the popthenPush below and pause execution
      // until the session is established.
      // Then we can fill in the address and continue execution.
      this.withCroquetNetworkDo(function (network) {
        for (var i = 0; i < 4; i++) {
          localAddressOop.bytes[i] = this.croquetAddress[i];
        }
        DEBUG > 1 && console.log("primitiveResolverLocalAddress => " + localAddressOop.bytes.join("."));
      }.bind(this));

      this.interpreterProxy.popthenPush(argCount + 1, localAddressOop);
      return true;
    },

    /****************** CROQUET STUFF ******************/

    croquetRegisterSocket: function (socket, port) {
      socket.isCroquet = true;

      var tcp = socket.type === this.TCP_Socket_Type;
      var ports = tcp ? this.croquetTCPPorts : this.croquetUDPPorts;
      if (ports[port]) {
        console.warn("Croquet network: port " + port + " is already in use");
        return 0;
      }
      if (!port) {
        var startPort = tcp ? this.croquetTCPNextPort : this.croquetUDPNextPort;
        for (port = startPort; port < 65536; port++) {
          if (!ports[port]) break;
        }
        if (ports[port]) {
          for (port = 49152; port < startPort; port++) {
            if (!ports[port]) break;
          }
        }
        if (ports[port]) {
          console.warn("Croquet network: no free port found");
          return 0;
        }
        if (tcp) this.croquetTCPNextPort = port + 1;
        else this.croquetUDPNextPort = port + 1;
      }
      ports[port] = socket;
      socket.localPort = port;

      DEBUG > 0 && console.log("Croquet network: registered " + socket);
      return port;
    },

    croquetListen: function (socket, port, backlog) {
      this.withCroquetNetworkDo(network => {
        DEBUG > 0 && console.log("Croquet network: " + socket + " listen on " + port);
        this.croquetRegisterSocket(socket, port);
        if (socket.type === this.UDP_Socket_Type) {
          // UDP: we're immediately ready to receive or send data
          socket.status = this.Socket_Connected;
        } else {
          // TCP: it's a lot more complicated, let the state machine handle
          socket.tcpBacklog = backlog;
          this.tcpOPEN(socket, false);
          // tcp state will be LISTEN
          // Squeak status will be this.Socket_WaitingForConnection
        }
        socket.listening = true;
      });
      return true;
    },

    croquetConnect: function (socket, dstAddr, port) {
      this.withCroquetNetworkDo(network => {
        const dst = dstAddr.join(".");
        DEBUG > 0 && console.log("Croquet network: " + socket + " connecting to " + dst + ":" + port + " ...");
        this.croquetRegisterSocket(socket);
        socket.hostAddress = dstAddr;
        socket.host = dst;
        socket.port = port;
        if (socket.type === this.UDP_Socket_Type) {
          socket.status = this.Socket_Connected; // ready to receive or send
          socket._signalConnSemaphore();
          socket._signalWriteSemaphore(); // Immediately ready to write
          DEBUG > 0 && console.log("Croquet network: " + socket + " connected");
        } else { // TCP
          this.tcpOPEN(socket, true);
          // tcp state will be SYN-SENT
          // Squeak status will be this.Socket_WaitingForConnection
        }
      });
      return true;
    },

    udpSend: function (socket, data) {
      var dataLength = data ? data.length : 0;
      this.withCroquetNetworkDo(network => {
        DEBUG > 0 && console.log("Croquet network: " + socket + " send " + dataLength + " bytes");
        const ipPacket = new Uint8Array(UDP_HEADER + dataLength);
        const src = this.croquetAddress;
        const dst = socket.hostAddress;
        ipPacket.set(src, 0);
        ipPacket.set(dst, 4);
        ipPacket[ 8] = socket.type; // UDP
        ipPacket[ 9] = socket.localPort >> 8;
        ipPacket[10] = socket.localPort & 0xFF;
        ipPacket[11] = socket.port >> 8;
        ipPacket[12] = socket.port & 0xFF;
        if (dataLength > 0) ipPacket.set(data, UDP_HEADER);
        network.send(ipPacket);
        this.lastCroquetSend = Date.now();
        this.writeSemaNeeded = true;
        setTimeout(() => this.udpSendDone(socket, true), CROQUET_RATE_LIMIT);
      });
      return dataLength;
    },

    lastCroquetSend: 0,
    writeSemaNeeded: false,

    udpSendDone: function (socket, signal) {
      var msSinceLastSend = Date.now() - this.lastCroquetSend;
      var wait = CROQUET_RATE_LIMIT - msSinceLastSend;
      var done = wait <= 0;
      DEBUG > 2 && !done && console.log("Croquet network: send limit wait time " + (CROQUET_RATE_LIMIT - msSinceLastSend) + "ms");
      if (done && this.writeSemaNeeded) {
        if (signal) socket._signalWriteSemaphore();
        this.writeSemaNeeded = false;
      }
      return done;
    },

    croquetReceive(ipPacket) {
      const type = ipPacket[8];
      const ports = type === this.UDP_Socket_Type ? this.croquetUDPPorts : this.croquetTCPPorts;
      const dstPort = ipPacket[11] << 8 | ipPacket[12];
      const socket = ports[dstPort];
      if (!socket) {
        DEBUG > 2 && console.log("Croquet network: receiving " + ipPacket.length + " bytes for unregistered port " + dstPort);
        return;
      }
      // handle TCP
      if (socket.type === this.TCP_Socket_Type) {
        return this.tcpSEGMENT_ARRIVED(socket, ipPacket);
      }
      // handle UDP
      DEBUG > 0 && console.log("Croquet network: receiving " + ipPacket.length + " bytes for " + socket);
      if (socket.status === this.Socket_Connected) {
        if (!socket.hostAddress) {
          const src = ipPacket.slice(0, 4);
          const srcPort = ipPacket[9] << 8 | ipPacket[10];
          socket.hostAddress = src;
          socket.host = socket.hostAddress.join(".");
          socket.port = srcPort;
        }
        // socket is connected, so this is data
        const payload = ipPacket.subarray(UDP_HEADER);
        if (!socket.response) socket.response = [];
        socket.response.push(payload);
        socket.responseReceived = true;
        socket._signalReadSemaphore();
      } else {
       debugger
      }
    },

    croquetClose: function (socket) {
        DEBUG > 0 && console.log("Croquet network: " + socket + " closing");
        if (socket.type === this.UDP_Socket_Type) {
          if (socket.status === this.Socket_Connected) {
            socket.hostAddress = null;
            socket.host = null;
            socket.port = 0;
          } else {
            debugger
          }
          if (socket.listening) {
            socket.listening = false;
          }
        } else { // TCP
          this.tcpCLOSE(socket);
        }
      return true;
    },

    croquetDestroy: function (socket) {
      if (!socket.isCroquet) return false;
      if (socket.status !== this.Socket_Unconnected) {
        this.croquetClose(socket);
      }
      var ports = socket.type === this.UDP_Socket_Type ? this.croquetUDPPorts : this.croquetTCPPorts;
      delete ports[socket.localPort];
      socket.localPort = 0;
      DEBUG > 0 && console.log("Croquet network: " + socket + " destroyed (now " + Object.keys(ports).length + " ports)");
      // TODO: leave Croquet session if no more sockets
      return true;
    },

    tcpInitialSeq: function () {
      // not quite to spec, but good enough
      return Math.floor(Math.random() * 0xFFFFFFFF);
    },

    tcpCreateTCB: function (socket) {
      socket.tcpPrev = socket.tcpState = "CLOSED";
      // let's use actual Transmission Control Buffer variable names
      socket.TCB = {
        SND_UNA:  0, // send unacknowledged
        SND_NXT:  0, // send next
        SND_WND:  0, // send window
        SND_WL1:  0, // segment sequence number used for last window update
        SND_WL2:  0, // segment acknowledgment number used for last window update
        ISS:      0, // initial send sequence number
        RCV_NXT:  0, // receive next
        RCV_WND:  0, // receive window
        IRS:      0, // initial receive sequence number
        SEG_SEQ:  0, // sequence number
        SEG_ACK:  0, // acknowledgment number
        SEG_LEN:  0, // segment length
        SEG_WND:  0, // segment window
        sndQueue: [],
        rcvQueue: [],
      };
      socket.TCB.SND_WND = socket.sendBufSize;
      socket.TCB.RCV_WND = socket.recvBufSize;
      socket.response = socket.TCB.rcvQueue; // for Squeak
    },

    tcpDeleteTCB: function (socket) {
      socket.tcpState = null;
      socket.TCB = null;
      // todo: flush retransmit queue, delete timeouts
      if (socket.status !== this.Socket_Unconnected) {
        socket.status = this.Socket_Unconnected; // for Squeak
        socket._signalConnSemaphore();
      }
      this.croquetDestroy(socket);
    },

    tcpUnusedSendBuffer: function (socket, msg) {
      const TCB = socket.TCB;
      let used = seqNum(TCB.SND_NXT - TCB.SND_UNA);
      let unused = socket.sendBufSize - used;
      let unacked = used;
      if (DEBUG > 2 && used > 0) {
        unacked += " (" + seqNum(TCB.SND_UNA - TCB.ISS) + ":" + seqNum(TCB.SND_NXT - TCB.ISS) + ")";
      }
      DEBUG > 2 && console.log("unacked: " + unacked + ", free: " + unused + " " + (msg || ""));
      return unused;
    },

    tcpSendDone: function (socket) {
      if (socket.tcpState !== "ESTABLISHED" && socket.tcpState !== "CLOSE-WAIT") {
        return false;
      }
      // the previous send is "done" (meaning the app can send more data)
      // if there is still room in the send buffer
      const done =  this.tcpUnusedSendBuffer(socket, "tcpSendDone?") > 0;
      if (!done) {
        this.vm.breakNow();
        DEBUG > 2 && console.log("Croquet network: breaking out of VM loop to receive acks");
      }
      return done;
    },

    tcpSendSegment: function (socket, seq, ack, flags, data) {
      if (flags === undefined) debugger
      const TCB = socket.TCB;
      const segment = {
        seq: seq,
        ack: ack,
        flags: flags,
        data: data || [],
      };
      const ipPacket = new Uint8Array(TCP_HEADER + segment.data.length);
      const src = this.croquetAddress;
      const dst = socket.hostAddress;
      ipPacket.set(src, 0);
      ipPacket.set(dst, 4);
      ipPacket[ 8] = socket.type; // UDP or TCP
      ipPacket[ 9] = socket.localPort >> 8;
      ipPacket[10] = socket.localPort & 0xFF;
      ipPacket[11] = socket.port >> 8;
      ipPacket[12] = socket.port & 0xFF;
      ipPacket[13] = seq >> 24;
      ipPacket[14] = seq >> 16 & 0xFF;
      ipPacket[15] = seq >> 8 & 0xFF;
      ipPacket[16] = seq & 0xFF;
      ipPacket[17] = ack >> 24;
      ipPacket[18] = ack >> 16 & 0xFF;
      ipPacket[19] = ack >> 8 & 0xFF;
      ipPacket[20] = ack & 0xFF;
      ipPacket[21] = flags;
      ipPacket[22] = TCB.RCV_WND >> 8;
      ipPacket[23] = TCB.RCV_WND & 0xFF;
      if (segment.data.length > 0) {
        ipPacket.set(data, TCP_HEADER);
        TCB.SND_NXT = seqNum(TCB.SND_NXT + segment.data.length);
      }
      this.withCroquetNetworkDo(network => network.send(ipPacket));
      if (segment.data.length > 0 || (flags & TCP_SYN) || (flags & TCP_FIN)) {
        TCB.sndQueue.push(segment);
        DEBUG > 2 && segment.data.length && this.tcpUnusedSendBuffer(socket, "sent " + segment.data.length + " bytes"); // just for logging
      }
    },

    tcpRemoveAckedSegmentsFromRetransmitQueue: function (socket) {
      const TCB = socket.TCB;
      const ack = TCB.SND_UNA;
      const acked = [];
      for (let i = 0; i < TCB.sndQueue.length; i++) {
        const segment = TCB.sndQueue[i];
        if (segment.seq + segment.data.length <= ack) {
          acked.push(segment);
        }
      }
      if (acked.length > 0) {
        TCB.sndQueue = TCB.sndQueue.filter(segment => !acked.includes(segment));
        const free = this.tcpUnusedSendBuffer(socket, "removed acked segs");
        if (free > 0) {
          socket._signalWriteSemaphore(); // for Squeak
        }
      }
    },

    tcpUpdateReceiveWindow: function (socket) {
      // if RCV.BUFF - RCV.USER - RCV.WND  >= min(0.5 * RCV.BUFF, Eff.snd.MSS )
      // then RCV.WND = RCV.BUFF - RCV.USER
      const TCB = socket.TCB;
      const rcvBuff = socket.recvBufSize;
      const rcvUser = TCB.rcvQueue.reduce((sum, data) => sum + data.length, 0);
      DEBUG > 2 && console.log("Croquet network: received " + rcvUser + " bytes, window is " + TCB.RCV_WND + " of " + rcvBuff);
      const free = rcvBuff - rcvUser - TCB.RCV_WND;
      if (free >= Math.min(0.5 * rcvBuff, CROQUET_MMS)) {
        // increase the window
        TCB.RCV_WND = rcvBuff - rcvUser;
        DEBUG > 2 && console.log("Croquet network: " + socket + " increased receive window to " + TCB.RCV_WND);
      } else if (free < 0) {
        // decrease the window
        TCB.RCV_WND = rcvBuff - rcvUser;
        DEBUG > 2 && console.log("Croquet network: " + socket + " decreased receive window to " + TCB.RCV_WND);
      }
    },

    tcpDeliverDataAndSendAck: function (socket, data) {
      // Once the TCP endpoint takes responsibility for the data, it advances RCV.NXT
      // over the data accepted, and adjusts RCV.WND as appropriate to the current
      // buffer availability. The total of RCV.NXT and RCV.WND should not be reduced.
      const TCB = socket.TCB;
      TCB.rcvQueue.push(data);
      socket._signalReadSemaphore(); // for Squeak
      const oldRcvEnd = seqNum(TCB.RCV_NXT + TCB.RCV_WND);
      TCB.RCV_NXT = seqNum(TCB.RCV_NXT + data.length);
      this.tcpUpdateReceiveWindow(socket);
      const newRcvEnd = seqNum(TCB.RCV_NXT + TCB.RCV_WND);
      if (seqLT(newRcvEnd, oldRcvEnd)) {
        // window shrunk ... not good
        debugger
      }
      // Send an acknowledgment of the form:
      // <SEQ=SND.NXT><ACK=RCV.NXT><CTL=ACK>
      // TODO: This acknowledgment should be piggybacked on a segment being transmitted if possible without incurring undue delay.
      this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_ACK);
    },

    tcpOPEN: function (socket, active) {
      if (!socket.TCB) this.tcpCreateTCB(socket);
      const TCB = socket.TCB;
      DEBUG > 1 && console.log("Processing OPEN (" + socket.tcpState + ") " + socket);
      switch (socket.tcpState) {
        case "CLOSED":
        case "LISTEN":
          if (!active) {
            // Passive OPEN
            if (socket.tcpState !== "LISTEN") {
              socket.tcpPrev = socket.tcpState; socket.tcpState = "LISTEN";
              socket.status = this.Socket_WaitingForConnection; // for Squeak
            }
          } else {
            // Active OPEN (see also tcpSEND)
            TCB.ISS = this.tcpInitialSeq();
            this.tcpSendSegment(socket, TCB.ISS, 0, TCP_SYN);
            TCB.SND_UNA = TCB.ISS;
            TCB.SND_NXT = seqNum(TCB.ISS + 1);
            socket.tcpPrev = socket.tcpState; socket.tcpState = "SYN-SENT";
            socket.status = this.Socket_WaitingForConnection; // for Squeak
          }
          break;
        default:
          DEBUG > 0 && console.warn("Croquet network error: connection already exists " + socket);
          debugger
      }
      DEBUG > 2 && console.log("Processed OPEN (" + socket.tcpState + ") " + socket);
    },

    tcpSEND: function (socket, data) {
      const TCB = socket.TCB;
      switch (socket.tcpState || "CLOSED") {
        case "CLOSED":
          DEBUG > 0 && console.warn("Croquet network: socket is closed " + socket);
          return -1; // error
        case "LISTEN":
          // Active OPEN (same as in tcpOPEN)
          if (!socket.hostAddress || data.length > 0) {
            console.warn("Croquet network: socket is not connected " + socket);
            return -1; // error
          }
          TCB.ISS = this.tcpInitialSeq();
          this.tcpSendSegment(socket, TCB.ISS, 0, TCP_SYN);
          TCB.SND_UNA = TCB.ISS;
          TCB.SND_NXT = seqNum(TCB.ISS + 1);
          socket.tcpPrev = socket.tcpState; socket.tcpState = "SYN-SENT";
          socket.status = this.Socket_WaitingForConnection; // for Squeak
          return 0; // success
        case "SYN-SENT":
        case "SYN-RECEIVED":
          if (data.length > 0) {
            DEBUG > 0 && console.warn("Croquet network: socket is not connected " + socket);
            return -1; // error
          }
        case "ESTABLISHED":
        case "CLOSE-WAIT":
          if (data.length === 0) return 0; // success
          const unused = this.tcpUnusedSendBuffer(socket, "can send?");
          if (data.length > unused) {
            if (unused === 0) return 0; // success
            data = data.subarray(0, unused);
          }
          this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_ACK, data);
          return data.length; // success
        case "FIN-WAIT-1":
        case "FIN-WAIT-2":
        case "CLOSING":
        case "LAST-ACK":
        case "TIME-WAIT":
          DEBUG > 0 && console.warn("Croquet network: connection is closing " + socket);
          return -1; // error
      }
    },

    tcpRECEIVE: function (socket, maxBytes) {
      const TCB = socket.TCB;
      switch (socket.tcpState || "CLOSED") {
        case "CLOSED":
          DEBUG > 0 && console.warn("Croquet network: connection does not exist " + socket);
          return null; // error
        case "SYN-SENT":
        case "SYN-RECEIVED":
        case "LISTEN":
          return []; // no data
        case "CLOSE-WAIT":
          if (!TCB.rcvQueue[0]) {
            DEBUG > 0 && console.warn("Croquet network: connection closing " + socket);
            return null; // error
          }
          // fall through
        case "ESTABLISHED":
        case "FIN-WAIT-1":
        case "FIN-WAIT-2":
          // deliver data from the receive queue
          var data = TCB.rcvQueue[0];
          if (!data) return [];
          if (data.length <= maxBytes) {
            TCB.rcvQueue.shift();
          } else {
            var rest = data.subarray(maxBytes);
            TCB.rcvQueue[0] = rest;
            data = data.subarray(0, maxBytes);
          }
          return data;
        case "CLOSING":
        case "LAST-ACK":
        case "TIME-WAIT":
          DEBUG > 0 && console.warn("Croquet network: connection is closing " + socket);
          return null; // error
      }
    },

    tcpCLOSE: function (socket) {
      const TCB = socket.TCB;
      switch (socket.tcpState || "CLOSED") {
        case "CLOSED":
          DEBUG > 0 && console.warn("Croquet network: socket is closed " + socket);
          return -1; // error
        case "LISTEN":
          socket.tcpPrev = socket.tcpState; socket.tcpState = "CLOSED";
          this.tcpDeleteTCB(socket);
          return 0; // success
        case "SYN-SENT":
          socket.tcpPrev = socket.tcpState; socket.tcpState = "CLOSED";
          this.tcpDeleteTCB(socket);
          return 0; // success
        case "SYN-RECEIVED":
            if (TCB.sndQueue.length === 0) {
            this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_FIN);
            socket.tcpPrev = socket.tcpState; socket.tcpState = "FIN-WAIT-1";
          } else {
            this.tcpQueueSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_FIN);
          }
          return 0; // success
        case "ESTABLISHED":
          this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_FIN);
          socket.tcpPrev = socket.tcpState; socket.tcpState = "FIN-WAIT-1";
          return 0; // success
        case "CLOSE-WAIT":
          this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_FIN);
          socket.tcpPrev = socket.tcpState; socket.tcpState = "LAST-ACK";
          return 0; // success
        case "FIN-WAIT-1":
        case "FIN-WAIT-2":
        case "CLOSING":
        case "LAST-ACK":
        case "TIME-WAIT":
          DEBUG > 0 && console.warn("Croquet network: connection is closing " + socket);
          return -1; // error
      }
    },

    tcpABORT: function (socket) {
      debugger
    },

    tcpSTATUS: function (socket) {
      debugger
    },

    tcpSEGMENT_ARRIVED: function (socket, ipPacket) {
      // this is a beast of a method, but it follows the RFC literally
      const SEG_SEQ = seqNum(ipPacket[13] << 24 | ipPacket[14] << 16 | ipPacket[15] << 8 | ipPacket[16]);
      const SEG_ACK = seqNum(ipPacket[17] << 24 | ipPacket[18] << 16 | ipPacket[19] << 8 | ipPacket[20]);
      const SEG_CTL = ipPacket[21];
      const SEG_WND = ipPacket[22] << 8 | ipPacket[23];
      const SEG_LEN = ipPacket.length - TCP_HEADER;
      const TCB = socket.TCB;
      DEBUG > 2 && console.log("Croquet network: " + socket + " received " + SEG_LEN + " bytes in " + socket.tcpState + " state");
      if (SEG_LEN > 0 && SEG_ACK - TCB.IRS === 12001) debugger
      switch (socket.tcpState || "CLOSED") {
        // ------------------------------------------------------------
        case "CLOSED":
          if (SEG_CTL & TCP_RST) return;
          if (SEG_CTL & TCP_ACK) this.tcpSendSegment(socket, SEG_ACK, 0, TCP_RST);
          else this.tcpSendSegment(socket, 0, SEG_SEQ + SEG_LEN, TCP_RST | TCP_ACK);
          return;
        case "LISTEN":
          // first check for an RST
          if (SEG_CTL & TCP_RST)
            return; // ignore
          // second check for an SEG_ACK
          if (SEG_CTL & TCP_ACK) {
            this.tcpSendSegment(socket, SEG_ACK, 0, TCP_RST);
            return;
          }
          // third check for a SYN
          if (SEG_CTL & TCP_SYN) {
            if (!socket.hostAddress) {
              socket.hostAddress = ipPacket.slice(0, 4);
              socket.host = socket.hostAddress.join(".");
              socket.port = ipPacket[9] << 8 | ipPacket[10];
            }
            TCB.RCV_NXT = seqNum(SEG_SEQ + 1);
            TCB.IRS = SEG_SEQ;
            TCB.ISS = this.tcpInitialSeq();
            this.tcpSendSegment(socket, TCB.ISS, TCB.RCV_NXT, TCP_SYN|TCP_ACK);
            TCB.SND_UNA = TCB.ISS;
            TCB.SND_NXT = seqNum(TCB.ISS + 1);
            socket.tcpPrev = socket.tcpState; socket.tcpState = "SYN-RECEIVED";
            // TODO: "Note that any other
            // incoming control or data (combined with SYN) will be processed
            // in the SYN-RECEIVED state, but processing of SYN and SEG_ACK should
            // not be repeated."
            if (SEG_LEN > 0) {
              console.warn("Croquet network: received " + SEG_LEN + " bytes in SYN-RECEIVED state");
              debugger
            }
            return;
          }
          // fourth, other text or control
          // we shouldn't get here
          return;
        // ------------------------------------------------------------
        case "SYN-SENT":
          // first check the ACK bit
          if (SEG_CTL & TCP_ACK) {
            if (SEG_ACK <= TCB.ISS || SEG_ACK > TCB.SND_NXT) {
              if (!SEG_CTL & TCP_RST) this.tcpSendSegment(socket, SEG_ACK, 0, TCP_RST);
              return; // ignore
            }
          }
          // second check the RST bit
          if (SEG_CTL & TCP_RST) {
            if (SEG_CTL & TCP_ACK) {
              socket.tcpPrev = socket.tcpState; socket.tcpState = "CLOSED";
              socket.status = this.Socket_Unconnected; // for Squeak
              socket._signalConnSemaphore();
              DEBUG > 0 && console.log("Croquet network: reset " + socket);
            }
            return;
          }
          // third check the security and precedence
          // fourth check the SYN bit
          if (SEG_CTL & TCP_SYN) {
            TCB.RCV_NXT = seqNum(SEG_SEQ + 1);
            TCB.IRS = SEG_SEQ;
            if (SEG_CTL & TCP_ACK) {
              TCB.SND_UNA = SEG_ACK;
              this.tcpRemoveAckedSegmentsFromRetransmitQueue(socket);
            }
            if (TCB.SND_UNA > TCB.ISS) {
              socket.tcpPrev = socket.tcpState; socket.tcpState = "ESTABLISHED";
              socket.status = this.Socket_Connected; // for Squeak
              socket._signalConnSemaphore();
              this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_ACK);
              // TODO: if data was received in the SYN-RECEIVED
              // state, process it now
              return
            }
            socket.tcpPrev = socket.tcpState; socket.tcpState = "SYN-RECEIVED";
            this.tcpSendSegment(socket, TCB.ISS, TCB.RCV_NXT, TCP_SYN|TCP_ACK);
            TCB.SND_WND = SEG_WND;
            TCB.SND_WL1 = SEG_SEQ;
            TCB.SND_WL2 = SEG_ACK;
            if (SEG_LEN > 0) {
              console.warn("Croquet network: received " + SEG_LEN + " bytes in SYN-RECEIVED state");
              debugger
            }
            return;
          }
          // fifth, if neither of the SYN or RST bits is set then drop the
          // segment and return.
          return;
        // ------------------------------------------------------------
        // Otherwise
        default:
        // first check sequence number
        let acceptable = false;
        if (SEG_LEN === 0) {
          if (TCB.RCV_WND === 0) {
            acceptable = SEG_SEQ === TCB.RCV_NXT;
          } else {
            acceptable = seqLE(TCB.RCV_NXT, SEG_SEQ) && seqLT(SEG_SEQ, TCB.RCV_NXT + TCB.RCV_WND);
          }
        } else {
          if (TCB.RCV_WND === 0) {
            acceptable = false;
          } else {
            acceptable = seqLE(TCB.RCV_NXT, SEG_SEQ) && seqLT(SEG_SEQ, TCB.RCV_NXT + TCB.RCV_WND) ||
              seqLE(TCB.RCV_NXT, SEG_SEQ + SEG_LEN - 1) && seqLT(SEG_SEQ + SEG_LEN - 1, TCB.RCV_NXT + TCB.RCV_WND);
          }
        }
        if (!acceptable) {
          if (SEG_CTL & TCP_RST) return; // ignore
          DEBUG > 2 && console.warn("Croquet network: rejecting segment " + seqNum(SEG_SEQ - TCB.IRS) + ":" + seqNum(SEG_SEQ + SEG_LEN - TCB.IRS)
            + ", window is " + seqNum(TCB.RCV_NXT - TCB.IRS) + ":" + seqNum(TCB.RCV_NXT + TCB.RCV_WND - TCB.IRS));
          this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_ACK);
          return;
        }
        // second, check the RST bit
        if (SEG_CTL & TCP_RST) {
          if (socket.tcpState === "SYN-RECEIVED" && socket.tcpPrev === "LISTEN") {
            socket.tcpPrev = socket.tcpState; socket.tcpState = "LISTEN";
            socket.status = this.Socket_WaitingForConnection; // for Squeak
            socket._signalConnSemaphore();
          } else {
            this.deleteTCB(socket); // will signal Squeak
          }
          return;
        }
        // third, check security
        // fourth, check the SYN bit
        if (SEG_CTL & TCP_SYN) {
          if (socket.tcpState === "SYN-RECEIVED" && socket.tcpPrev === "LISTEN") {
            socket.tcpPrev = socket.tcpState; socket.tcpState = "LISTEN";
            socket.status = this.Socket_WaitingForConnection; // for Squeak
            socket._signalConnSemaphore();
            return;
          }
          // this is RFC 5961 / 9293 behavior (it was an error in RFC 793)
          this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_ACK);
          return;
        }
        // fifth, check the SEG_ACK field
        if (!(SEG_CTL & TCP_ACK)) return; // ignore
        if (socket.tcpState === "SYN-RECEIVED") {
          if (seqLT(TCB.SND_UNA, SEG_ACK) && seqLE(SEG_ACK, TCB.SND_NXT)) {
            socket.tcpPrev = socket.tcpState; socket.tcpState = "ESTABLISHED";
            socket.status = this.Socket_Connected; // for Squeak
            socket._signalConnSemaphore();
            TCB.SND_WND = SEG_WND;
            TCB.SND_WL1 = SEG_SEQ;
            TCB.SND_WL2 = SEG_ACK;
          } else {
            this.tcpSendSegment(socket, SEG_ACK, 0, TCP_RST);
            return;
          }
          // proceed in ESTABLISHED state
        }
        if (["ESTABLISHED", "FIN-WAIT-1", "FIN-WAIT-2", "CLOSE-WAIT", "CLOSING"].includes(socket.tcpState)) {
          if (seqGT(SEG_ACK, TCB.SND_NXT)) {
            DEBUG > 2 && console.warn("Croquet network: rejecting segment " + seqNum(SEG_SEQ - TCB.IRS) + ":" + seqNum(SEG_SEQ + SEG_LEN - TCB.IRS)
              + ", SND_NXT is " + seqNum(TCB.SND_NXT - TCB.ISS) + ", ACK is " + seqNum(SEG_ACK - TCB.ISS));
            this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_ACK);
            return; // ignore
          }
          if (seqLT(TCB.SND_UNA, SEG_ACK) && seqLE(SEG_ACK, TCB.SND_NXT)) {
            TCB.SND_UNA = SEG_ACK;
            this.tcpRemoveAckedSegmentsFromRetransmitQueue(socket);
          }
          if (seqLT(TCB.SND_UNA, SEG_ACK) && seqLE(SEG_ACK, TCB.SND_NXT)) {
            if (seqLT(TCB.SND_WL1, SEG_SEQ) || (TCB.SND_WL1 === SEG_SEQ && seqLE(TCB.SND_WL2, SEG_ACK))) {
              TCB.SND_WND = SEG_WND;
              TCB.SND_WL1 = SEG_SEQ;
              TCB.SND_WL2 = SEG_ACK;
            }
          }
          if (socket.tcpState === "FIN-WAIT-1") {
            debugger
            // if the FIN segment is now acknowledged then enter FIN-WAIT-2
            if (TCB.SND_UNA === TCB.SND_NXT) {
              socket.tcpPrev = socket.tcpState; socket.tcpState = "FIN-WAIT-2";
            }
          }
          if (socket.tcpState === "FIN-WAIT-2") {
            debugger
            // if the retransmission queue is empty, the user's CLOSE can be acknowledged ("ok") but do not delete the TCB
            if (socket.sndQueue.length === 0) {
              socket.status = this.Socket_Unconnected; // for Squeak
              socket._signalConnSemaphore();
            }
          }
          // if (socket.tcpState === "CLOSE-WAIT") do nothing
          if (socket.tcpState === "CLOSING") {
            debugger
            // if the ACK acknowledges our FIN then enter the TIME-WAIT state
            // and start the time-wait timer, otherwise ignore the segment
            if (TCB.SND_UNA === TCB.SND_NXT) {
              socket.tcpPrev = socket.tcpState; socket.tcpState = "TIME-WAIT";
            }
          }
        } // end of ESTABLISHED, FIN-WAIT-1, FIN-WAIT-2, CLOSE-WAIT, CLOSING
        if (socket.tcpState === "LAST-ACK") {
          debugger
          // if the ACK acknowledges our FIN then delete the TCB and return
          if (TCB.SND_UNA === TCB.SND_NXT) {
            this.tcpDeleteTCB(socket);
            return;
          }
        }
        if (socket.tcpState === "TIME-WAIT") {
          debugger
          // restart the 2MSL time-wait timeout
          this.startTCPTimer(socket, 2 * TCP_MSL);
          return;
        }
        // sixth, check the URG bit
        // seventh, process the segment text
        if (SEG_LEN > 0) {
          if (["ESTABLISHED", "FIN-WAIT-1", "FIN-WAIT-2"].includes(socket.tcpState)) {
            // Once the TCP endpoint takes responsibility for the data, it advances RCV.NXT
            // over the data accepted, and adjusts RCV.WND as appropriate to the current
            // buffer availability. The total of RCV.NXT and RCV.WND should not be reduced.
            this.tcpDeliverDataAndSendAck(socket, ipPacket.subarray(TCP_HEADER));
            // Send an acknowledgment of the form:
            // <SEQ=SND.NXT><ACK=RCV.NXT><CTL=ACK>
            // This acknowledgment should be piggybacked on a segment being transmitted if possible without incurring undue delay.
          }
        }
        // eighth, check the FIN bit
        if (SEG_CTL & TCP_FIN) {
          if (["CLOSED", "LISTEN", "SYN-SENT"].includes(socket.tcpState)) return;
          TCB.RCV_NXT = seqNum(SEG_SEQ + 1);
          this.tcpSendSegment(socket, TCB.SND_NXT, TCB.RCV_NXT, TCP_ACK);
          if (socket.tcpState === "SYN-RECEIVED" || socket.tcpState === "ESTABLISHED") {
            socket.tcpPrev = socket.tcpState; socket.tcpState = "CLOSE-WAIT";
            socket.status = this.Socket_OtherEndClosed; // for Squeak
            socket._signalConnSemaphore();
          }
          if (socket.tcpState === "FIN-WAIT-1") {
            if (TCB.SND_UNA === TCB.SND_NXT) {
              socket.tcpPrev = socket.tcpState; socket.tcpState = "TIME-WAIT";
            } else {
              socket.tcpPrev = socket.tcpState; socket.tcpState = "CLOSING";
            }
          }
          if (socket.tcpState === "FIN-WAIT-2") {
            socket.tcpPrev = socket.tcpState; socket.tcpState = "TIME-WAIT";
          }
          if (socket.tcpState === "TIME-WAIT") {
            this.startTCPTimer(socket, 2 * TCP_MSL);
          }
        }
      }
    },

    tcpTimeWait: function (socket) {
      socket.status = this.Socket_Unconnected; // for Squeak
      socket._signalConnSemaphore();
      setTimeout(() => this.tcpProcessEvent(socket, "timeout"), 2 * TCP_MSL);
    },

    withCroquetNetworkDo: function (func) {
      // call func with the local NetworkHost instance

      // this.croquetNetwork is the Croquet session
      // it will only be null the first time we call this
      // this.croquetNetwork.view is the local NetworkHost instance
      // which may go away if the session went dormant
      if (this.croquetNetwork && this.croquetNetwork.view) {
        return func(this.croquetNetwork.view);
      }
      var primitiveName = this.interpreterProxy.primitiveName;
      DEBUG > 1 && console.log(">>>>>>>> freezing Squeak VM after " + primitiveName);
      this.vm.freeze(unfreeze => {
        // we need to freeze the VM until the session is established
        // so we can return the address
        function continueExecution() {
          if (unfreeze) {
            DEBUG > 1 && console.log(">>>>>>>> unfreezing Squeak VM after " + primitiveName);
            unfreeze();
          }
          unfreeze = null; // don't unfreeze twice
        }
        if (!this.croquetNetwork) {
          this.startCroquetNetwork()
            .then(() => {
              func(this.croquetNetwork.view);
              continueExecution();
            }).catch(error => {
              console.error("Failed to join Croquet session", error);
              alert("Failed to join Croquet session: " + error.message);
              throw error;
            });
        } else {
          // we have a session but view went away
          // wait for it to come back
          function checkForView() {
            if (this.croquetNetwork.view) {
              func(this.croquetNetwork.view);
              continueExecution();
            } else {
              setTimeout(checkForView, 200);
            }
          }
          checkForView = checkForView.bind(this);
          DEBUG > 0 && console.log("Croquet Network: disconnected from session, waiting for it to come back");
          checkForView();
        }
      });
    },

    /****************************************************************
     * Initially this plugin assumes it will only be used for http
     * requests, which are handled by fetch() / XMLHttpRequest.
     *
     * We only load Croquet when we need it, which typically is indicated
     * by the image requesting to know our local IP address, or by
     * starting to listen on a socket, or connecting a socket to an IP
     * address in our virtual subnet (10.42.0.0/16).
     *
     * As with all Croquet apps, the logic is split into a shared "model"
     * and a local "view". Our shared model is the NetworkRouter class below,
     * and the view is the NetworkHost class.
     *
     * The router allocates an IP address in our subnet for each joining host,
     * using the host's viewId as hostname. This basically emulates a DHCP service.
     * The hostname-to-ip mapping is kept for a certain time even if the host
     * goes away, so that it can rejoin with the same IP address. This happens
     * automatically when the Croquet session goes dormant (disconnects due to
     * the browser tab being hidden) and is resumed later.
     *
     * The Croquet router operates on the IP level. It doesn't know about TCP or
     * UDP, those packets (with e.g. source and destination ports) are
     * encapsulated in the IP packet payload. A host sends a packet by publishing
     * it to the router. The reouter forwards packets to the destination IP
     * address by re-publishing them. There is no buffering in the router, so if
     * the destination is not online, the packet is lost. The host's TCP
     * implementation will handle this, but UDP will not – as with the real internet.
     *
     * It's IP-over-Croquet, if you will.
     *
     * Events:
     *   ==> means published by router, subscribed by host
     *   <== means published by host or croquet, subscribed by router
     *
     *   <== session "view-join" (hostName)
     *   <== session "view-exit" (hostName)
     *   ==> "network" "host-online" (hostName, ip)   // these are just informational
     *   ==> "network" "host-offline" (hostName, ip)  // for debugging
     *   <== "network" "send" (src, dst, payload)     // src and dst are IP addresses
     *   ==> dst "recv" (src, dst, payload)          // dst IP can be a broadcast address
     */

    initCroquetClasses: function () {
      // the local NetworkHost below will call plugin.croquetReceive()
      // when it receives a packet from the router. This is so the
      // host view itself is stateless and can be destroyed and recreated,
      // which will happen when the browser tab is hidden and the Croquet
      // session goes dormant.
      const plugin = this;

      // the shared network router, syncronized by Croquet
      class NetworkRouter extends Croquet.Model {
        init(options) {
          super.init(options);
          this.hostNames = new Map(); // host name (viewId) => host
          this.ipAddresses = new Map(); // ip addr => host
          this.nextIP = 0xFFFD; // start high so we excercise the wrap-around code
          this.subscribe(this.sessionId, "view-join", this.hostJoined);
          this.subscribe(this.sessionId, "view-exit", this.hostExited);
          this.subscribe("network", "send", this.send);
        }

        hostJoined(name) {
          let host = this.hostNames.get(name);
          if (host) {
            // host rejoined
            host.offline = 0;
            DEBUG > 1 && console.log("@" + this.now() + " host online again: " + name + " => " + host.ip);
          } else {
            // assign new IP address
            const ip = this.allocateIP();
            host = {
              name: name,
              ip,
              offline: 0, // if non-zero, time when host went offline
            }
            this.hostNames.set(name, host);
            this.ipAddresses.set(ip, host);
            DEBUG > 1 && console.log("@" + this.now() + " host online: " + name + " => " + ip);
          }
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(network, host-online, [" + name + ", " + host.ip + "])");
          this.publish("network", "host-online", [ name, host.ip ]);
          this.cleanUpHosts();
        }

        hostExited(name) {
          const host = this.hostNames.get(name);
          host.offline = this.now();
          DEBUG > 1 && console.log("@" + this.now() + " host offline: " + name + " (" + host.ip + ")");
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(network, host-offline, [" + name + ", " + host.ip + "])");
          this.publish("network", "host-offline", [ name, host.ip ]);
        }

        send(packet) {
          const bytes = new Uint8Array(packet);
          const src = bytes.subarray(0, 4).join(".");
          const dst = bytes.subarray(4, 8).join(".");
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + dst + ", recv, " + packet.byteLength + " bytes])");
          this.publish(dst, "recv", packet);
        }

        allocateIP() {
          let ipNumber = this.nextIP;
          let ipBytes = CROQUET_NETWORK.slice(); // 10.42.0.0
          let ip;
          do {
            ipBytes[2] = ipNumber >> 8;
            ipBytes[3] = ipNumber & 0xFF;
            ip = ipBytes.join(".");
            if (++ipNumber > 0xFFFE) ipNumber = 1; // wrap around, skipping 0 and FFFF
            if (ipNumber === this.nextIP) {
              // we've wrapped around, so we're out of IP addresses
              const offlineHost = this.longestOfflineHost();
              if (offlineHost) {
                // reuse the IP address of the oldest offline host
                ip = offlineHost.ip;
                DEBUG > 1 && console.log("@" + this.now() + " " + offlineHost.name + " (" + ip + ") has been offline for too long, reusing IP address");
                this.hostNames.delete(offlineHost.name);
                this.ipAddresses.delete(ip);
              } else throw new Error("Too many participants"); // unlikely
            }
          } while (this.ipAddresses.has(ip));
          this.nextIP = ipNumber;
          return ip;
        }

        longestOfflineHost() {
          let found = null;
          for (const host of this.hostNames.values()) {
            if (host.offline && (!found || host.offline < found.offline)) {
              found = host;
            }
          }
          return found;
        }

        cleanUpHosts() {
          // remove hosts that have been offline for too long
          const now = this.now();
          for (const host of this.hostNames.values()) {
            if (host.offline && now - host.offline > CROQUET_RELEASE_HOSTNAME) {
              this.hostNames.delete(host.name);
              this.ipAddresses.delete(host.ip);
              DEBUG > 1 && console.log("@" + this.now() + " " + host.name + " (" + host.ip + ") has been offline for too long, removing");
            }
          }
        }

      }
      NetworkRouter.register("NetworkRouter");

      // the local host, a network participant
      class NetworkHost extends Croquet.View {
        constructor(model) {
          super(model);
          this.model = model;
          const firstTime = !plugin.croquetNetwork;
          const reconnecting = !firstTime;
          DEBUG > 0 && reconnecting && console.log("Croquet network: reconnected to session");
          const count = this.onlineHosts();
          firstTime && console.log("Croquet network: " + count + " host" + (count === 1 ? "" : "s") + " online," +
            " my IP: " + this.ip());
          this.subscribe(this.ip(), "recv", this.receive);
          this.subscribe(BROADCAST_ADDR, "recv", this.receive);
          this.subscribe("network", "host-online", this.hostOnline);
          this.subscribe("network", "host-offline", this.hostOffline);
        }

        send(bytes) {
          // the logic here is really simple but obscured by the debug code
          // so here's what it does:
          //    if (dst === this host) this.receive(bytes)
          //    else this.publish("network", "send", bytes);
          // That's it.
          DEBUG > 2 && this.tcpDump(bytes, "send");
          const packet = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength).buffer;
          if (packet.byteLength > CROQUET_MTU) {
            console.warn("Croquet network: Package size " + packet.byteLength
              + " bytes possibly too large for Croquet, need to implement fragmentation");
          }
          const dst = bytes.subarray(4, 8).join(".");
          if (dst === plugin.croquetAddr) {
            // if sending to self do not go through router
            DEBUG > 1 && console.log("Croquet network: sending " + packet.byteLength + " bytes to " + dst
              + " (shortcircuiting local host)");
            Promise.resolve()
              .then(() => this.receive(packet))
              .catch(err => { console.error(err); debugger});
          } else {
            // send to another host via router
            if (DEBUG > 2) this.logCroquetMessageSize();
            this.publish("network", "send", packet);
            DEBUG > 1 && console.log("Croquet network: sent " + packet.byteLength + " bytes to " + dst);
          }
        }

        receive(packet) {
          const bytes = new Uint8Array(packet);
          DEBUG > 2 && this.tcpDump(bytes, "recv");
          if (DEBUG > 1) {
            const src = bytes.subarray(0, 4).join(".");
            console.log("Croquet network: receiving " + packet.byteLength + " bytes from " + src);
          }
          plugin.croquetReceive(bytes);
        }

        hostOnline([ name, ip ]) {
          DEBUG > 0 && console.log("Croquet network: host came online " + name + " (" + ip + ")");
        }

        hostOffline([ name, ip ]) {
          DEBUG > 0 && console.log("Croquet network: host went offline " + name + " (" + ip + ")");
        }

        ip(name=this.viewId) {
          const host = this.model.hostNames.get(name);
          return host.ip;
        }

        onlineHosts() {
          let count = 0;
          for (const host of this.model.ipAddresses.values()) {
            if (!host.offline) {
              count++;
              DEBUG > 0 && console.log("Croquet network: " + count + ". "+ host.name +
              " " + host.ip + (host.name === this.viewId ? " (me)" : "" ));
            }
          }
          return count;
        }

        tcpDump(bytes, dir) {
          // format similar to tcpdump
          const src = bytes.subarray(0, 4).join(".");
          const dst = bytes.subarray(4, 8).join(".");
          const type = bytes[8] === plugin.UDP_Socket_Type ? "UDP" : bytes[8] === plugin.TCP_Socket_Type ? "TCP" : "IP" + bytes[8];

          let dump = type;
          let payload = bytes.length - IP_HEADER;

          if (type === "UDP" || type === "TCP") {
            const srcPort = bytes[9] << 8 | bytes[10];
            const dstPort = bytes[11] << 8 | bytes[12];
            if (dir === "send") {
              dump += " " + src + ":" + srcPort + " > " + dst + ":" + dstPort;
            } else {
              dump += " " + dst + ":" + dstPort + " < " + src + ":" + srcPort;
            }
            if (type === "UDP") {
              payload = bytes.length - UDP_HEADER;
            } else {
              // tcpDump() keeps track of the initial sequence number
              // so it can display relative sequence numbers
              // we cheat and reach into the socket's TCB
              const socket = plugin.croquetTCPPorts[dir === "send" ? srcPort : dstPort];
              const iss = socket && socket.TCB && (dir === "send" ? socket.TCB.ISS : socket.TCB.IRS) || 0;
              const irs = socket && socket.TCB && (dir === "send" ? socket.TCB.IRS : socket.TCB.ISS) || 0;
              payload = bytes.length - TCP_HEADER;
              const seq = seqNum(bytes[13] << 24 | bytes[14] << 16 | bytes[15] << 8 | bytes[16]);
              const ack = seqNum(bytes[17] << 24 | bytes[18] << 16 | bytes[19] << 8 | bytes[20]);
              const flags = bytes[21];
              const wnd = bytes[22] << 8 | bytes[23];
              dump += " ["
                + (flags & TCP_FIN ? "F" : "")
                + (flags & TCP_SYN ? "S" : "")
                + (flags & TCP_RST ? "R" : "")
                + (flags & TCP_ACK ? "." : "")
                + "]";
              if (flags & TCP_SYN) {
                dump += " seq " + seq + ",";
              } else if (payload > 0 || flags & TCP_FIN) {
                dump += " seq " + (seq - iss);
                if (payload > 0) {
                  dump += ":" + (seq - iss + payload - 1);
                }
                dump += ",";
              }
              if (flags & TCP_ACK) {
                dump += " ack " + (ack - irs) + ",";
              }
              dump += " win " + wnd;
              if (wnd > 0) {
                dump += " (" + (ack - irs) + ":" + (ack - irs + wnd - 1) + ")";
              }
              dump += ",";
            }
          } else {
            dump += " " + src + " > " + dst;
          }

          dump += " " + payload + " bytes";
          console.log(dump);
        }

        logCroquetMessageSize() {
          // Croquet's publish() method sends asynchronously, because it's encrypting
          // etc., so we can't measure the message size directly after sending.
          // Instead we hook into the stats object and measure the next message.
          // This is a bit of a hack, but it works.

          // The Croquet message will be a lot larger (depending on the Croquet version)
          // because currently it uses BASE64 encoding for binary data, it encrypts
          // the payload, and it adds a bunch of meta data.

          // seriously, Croquet, you don't have a way to get the actual message size?
          // gonna hook into your private API then...
          if (!CROQUETSTATS.orgAddNetworkTraffic) {
            CROQUETSTATS.orgAddNetworkTraffic = CROQUETSTATS.addNetworkTraffic;
          }
          CROQUETSTATS.addNetworkTraffic = (type, bytes) => {
            CROQUETSTATS.orgAddNetworkTraffic(CROQUETSTATS, type, bytes);
            if (type === "reflector_out") {
              console.log("Croquet network: last croquet msg " + bytes + " bytes");
              CROQUETSTATS.addNetworkTraffic = CROQUETSTATS.orgAddNetworkTraffic;
            }
          }
        }
      }

      this.NetworkRouter = NetworkRouter;
      this.NetworkHost = NetworkHost;
    },

    startCroquetNetwork: async function () {
      // load Croquet only once (and only if we need it)
      if (!window.Croquet) {
        await new Promise(resolve => {
          const script = document.createElement("script");
          script.src = CROQUET_URL;
          document.head.appendChild(script);
          script.onload = () => {
            if (!window.Croquet) {
              throw new Error("Could not load Croquet from " + CROQUET_URL);
            }
            this.initCroquetClasses();
            resolve();
          }
        });
      }

      // allow passing an API key via URL parameter for local development
      let apiKey = window.location.search.match(/apiKey=([^&]+)/);
      if (apiKey) apiKey = apiKey[1];
      else apiKey = CROQUET_APIKEY;

      const session = await Croquet.Session.join({
        apiKey,
        appId: CROQUET_APPID,
        model: this.NetworkRouter,
        view: this.NetworkHost,
        name: CROQUET_SESSION,
        password: CROQUET_PASSWORD,
        location: true,
        tps: 0, // since there are no future messages we don't need ticks
        debug: DEBUG > 2 && ["session", "subscribe"],
      });

      var ip = session.view.ip();
      this.croquetAddress = ip.split(".").map(function (s) { return +s; });
      this.croquetAddr = ip;
      this.croquetNetwork = session;
    },
  };
}

function registerSocketPlugin() {
  if (typeof Squeak === "object" && Squeak.registerExternalModule) {
    Squeak.registerExternalModule('SocketPlugin', SocketPlugin());
  } else self.setTimeout(registerSocketPlugin, 100);
};

registerSocketPlugin();
