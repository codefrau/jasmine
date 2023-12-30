/*
 * Croquet Jasmine Socket Plugin
 *
 * This plugin is a modified version of the SocketPlugin from the SqueakJS project.
 * It is used to provide a SocketPlugin for the Jasmine Smalltalk image.
 * It emulates a LAN connection by joining a (modern) Croquet.io session.
 *
 * ORIGINAL COMMENT FROM SOCKET PLUGIN

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

  var CROQUET_URL = "https://cdn.jsdelivr.net/npm/@croquet/croquet@1.1.0-41";
  var CROQUET_RATE_LIMIT = 1000 / 60; // 60 sends/s

  var BROADCAST_ADDR = "255.255.255.255";

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
    croquetTCPNextPort: 1024,
    croquetUDPPorts: {},
    croquetUDPNextPort: 1024,

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
    _newSocket: function (domain, socketType, rcvBufSize, sendBufSize, connSemaIdx, readSemaIdx, writeSemaIdx) {
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
          this.hostAddress = hostAddress;
          this.host = plugin._reverseLookupNameForAddress(hostAddress);
          this.port = port;
          // check if this is going to a croquet address (10.42.*.*), otherwise assume it's http
          var isCroquetAddress = plugin.croquetAddress && this.hostAddress[0] === plugin.croquetAddress[0] && this.hostAddress[1] === plugin.croquetAddress[1];
          if (isCroquetAddress) {
            plugin.croquetConnect(this, hostAddress, port);
          } else {
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
            var ports = this.type === plugin.TCP_Socket_Type ? plugin.croquetTCPPorts : plugin.croquetUDPPorts;
            delete ports[this.localPort];
            DEBUG > 0 && console.log("Croquet network: " + this + " released local port " + this.localPort + " (now " + Object.keys(ports).length + " ports)");
            plugin.croquetDestroy(this);
            this.localPort = null;
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
          if (this.isCroquet) return plugin.croquetTCPSend(this, data.bytes, start, end);
          if (this.sendTimeout !== null) {
            self.clearTimeout(this.sendTimeout);
          }
          this.lastSend = Date.now();
          var newBytes = data.bytes.subarray(start, end);
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

        sendUDP: function (data, start, end, address, port) {
          if (this.isCroquet) return plugin.croquetUDPSend(this, data, start, end, address, port);
          console.warn("udp not supported");
          return 0;
        },

        allocatePort: function (port) {
          var tcp = this.type === plugin.TCP_Socket_Type;
          var ports = tcp ? plugin.croquetTCPPorts : plugin.croquetUDPPorts;
          if (ports[port]) {
            console.warn("Croquet network: port " + port + " is already in use");
            return 0;
          }
          if (!port) {
            var startPort = tcp ? plugin.croquetTCPNextPort : plugin.croquetUDPNextPort;
            for (port = startPort; port < 65536; port++) {
              if (!ports[port]) break;
            }
            if (ports[port]) {
              for (port = 1024; port < startPort; port++) {
                if (!ports[port]) break;
              }
            }
            if (ports[port]) {
              console.warn("Croquet network: no free port found");
              return 0;
            }
            if (tcp) plugin.croquetTCPNextPort = port + 1;
            else plugin.croquetUDPNextPort = port + 1;
          }
          ports[port] = this;
          this.localPort = port;
          DEBUG > 0 && console.log("Croquet network: allocated: " + this);
          return port;
        },

        listen: function (port, backlog) {
          if (this.status !== plugin.Socket_Unconnected && this.type !== plugin.UDP_Socket_Type) {
            console.warn("Croquet network: socket is already connected");
            return false;
          }
          var success = plugin.croquetListen(this, port, backlog);
          if (success) this.listening = true;
          return success;
        },

        connectPending: function () {
          // we got a connection to this listening socket
          // and accept was not called, so we connect directly
          var srcAndPort = this.pendingConnections.shift().split(":");
          this.hostAddress = srcAndPort[0].split(".").map(function (d) { return +d; });
          this.port = srcAndPort[1];
        },

        [Symbol.toPrimitive]: function () {
          var name = this.name || "socket";
          var details = "";
          if (this.isCroquet) details += " Croquet";
          if (this.type === plugin.TCP_Socket_Type) details += " tcp";
          else if (this.type === plugin.UDP_Socket_Type) details += " udp";
          if (this.listening) details += " listening on: " + this.localPort;
          else if (this.localPort) details += " local: " + this.localPort;
          if (this.listenSocket) details += "(" + this.listenSocket.localPort + ")";
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

    socketCreate: function (domain, socketType, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex) {
      if (domain.isNil) domain = this.Domain_IPv4;
      if (domain !== this.Domain_IPv4) return false;
      var name = '{SqueakJS Socket #' + (++this.handleCounter) + '}';
      var sqHandle = this.primHandler.makeStString(name);
      var socket = this._newSocket(domain, socketType, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      socket.name = "socket#" + this.handleCounter;
      if (socketType === this.UDP_Socket_Type) {
        socket.status = this.Socket_Connected;
      }
      sqHandle.socket = socket;
      return sqHandle;
    },

    primitiveSocketCreate: function (argCount) {
      // older version of primitiveSocketCreate3Semaphores that is
      // invoked if that primitve failed
      if (argCount !== 5) return false;
      var domain = this.interpreterProxy.stackObjectValue(4);
      var socketType = this.interpreterProxy.stackIntegerValue(3);
      var rcvBufSize = this.interpreterProxy.stackIntegerValue(2);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(1);
      var semaIndex = this.interpreterProxy.stackIntegerValue(0);
      var sqHandle = this.socketCreate(domain, socketType, rcvBufSize, sendBufSize, semaIndex, semaIndex, semaIndex);
      DEBUG > 1 && console.log("primitiveSocketCreate => " + sqHandle);
      if (!sqHandle) return false;
      this.interpreterProxy.popthenPush(argCount + 1, sqHandle);
    },

    primitiveSocketCreate3Semaphores: function (argCount) {
      if (argCount !== 7) return false;
      var domain = this.interpreterProxy.stackObjectValue(6);
      var socketType = this.interpreterProxy.stackIntegerValue(5);
      var rcvBufSize = this.interpreterProxy.stackIntegerValue(4);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(3);
      var semaIndex = this.interpreterProxy.stackIntegerValue(2);
      var readSemaIndex = this.interpreterProxy.stackIntegerValue(1);
      var writeSemaIndex = this.interpreterProxy.stackIntegerValue(0);
      var sqHandle = this.socketCreate(domain, socketType, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
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
      var res = socket.send(data, start, end);
      this.interpreterProxy.popthenPush(argCount + 1, res);
      return true;
    },

    primitiveSocketSendDone: function (argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      var done = true;
      if (socket.isCroquet) done = this.croquetSendDone(socket);
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

      DEBUG > 1 && console.log("primitiveSocketSendUDPDataBufCount " + socket + " to " + host + ":" + port + " (" + count + " bytes)");

      var res = socket.sendUDP(data, start, end, host, port);
      this.interpreterProxy.popthenPush(argCount + 1, res);
      return true;
    },

    /****************** CROQUET STUFF ******************/

    primitiveSocketListenWithOrWithoutBacklog: function (argCount) {
      if (argCount < 2) return false;
      var socket = this.interpreterProxy.stackObjectValue(argCount - 1).socket;
      if (socket === undefined) return false;
      var portNumber = this.interpreterProxy.stackIntegerValue(argCount - 2);
      if (portNumber < 0 || portNumber > 65535) return false;
      var backlog = 0;
      if (argCount > 2) {
        backlog = this.interpreterProxy.stackIntegerValue(argCount - 3);
      }
      DEBUG > 1 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket, portNumber, backlog, "...");
      var success = socket.listen(portNumber, backlog);
      if (!success) {
        DEBUG > 1 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket + " => failed");
        return false;
      }
      DEBUG > 1 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket + " => success");
      this.interpreterProxy.pop(argCount);
      return true;
    },

    socketAccept: function (socket, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex) {
      var srcAndPort = socket.pendingConnections.shift();
      if (socket.pendingConnections.length === 0) {
        socket.status = this.Socket_WaitingForConnection;
      }
      if (!srcAndPort) return false;
      var newSocket = this.socketCreate(socket.domain, socket.type, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      if (!newSocket) return false;
      var [src, port] = srcAndPort.split(":"); port = +port;
      this.croquetAccept(socket, newSocket.socket, src, port);
      return newSocket;
    },

    primitiveSocketAccept3Semaphores: function (argCount) {
      if (argCount !== 6) return false;
      var socket = this.interpreterProxy.stackObjectValue(5).socket;
      if (socket === undefined) return false;
      var rcvBufSize = this.interpreterProxy.stackIntegerValue(4);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(3);
      var semaIndex = this.interpreterProxy.stackIntegerValue(2);
      var readSemaIndex = this.interpreterProxy.stackIntegerValue(1);
      var writeSemaIndex = this.interpreterProxy.stackIntegerValue(0);
      var newSocket = this.socketAccept(socket, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      DEBUG > 1 && console.log("primitiveSocketAccept3Semaphores " + socket + " => " + newSocket.socket);
      if (!newSocket) return false;
      this.interpreterProxy.popthenPush(argCount + 1, newSocket);
      return true;
    },

    primitiveSocketAccept: function (argCount) {
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var rcvBufSize = this.interpreterProxy.stackIntegerValue(2);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(1);
      var semaIndex = this.interpreterProxy.stackIntegerValue(0);
      var newSocket = this.socketAccept(socket, rcvBufSize, sendBufSize, semaIndex, semaIndex, semaIndex);
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

    croquetListen: function (socket, port, backlog) {
      socket.isCroquet = true;
      this.withCroquetNetworkDo(function (network) {
        port = socket.allocatePort(port);
        var type = socket.type === this.TCP_Socket_Type ? "tcp" : "udp";
        var ip = this.croquetAddr;
        var ipAndPort = ip + ":" + port;
        DEBUG > 0 && console.log("Croquet network: " + socket + " listen on " + ipAndPort);
        if (type === "tcp") {
          DEBUG > 2 && console.log("View.publish(" + ip + ":tcp-listen, { " + ip + ", " + port + " })");
          network.publish(ip, "tcp-listen", { ip, port });
          socket.pendingConnections = [];
          socket.status = this.Socket_WaitingForConnection;
          socket.sendIsReply = true;
          // socket._signalConnSemaphore();
          network.subscribe(ipAndPort, "tcp-connected-src", function tcpConnected(srcAndPort) {
            DEBUG > 0 && console.log("Croquet network: " + socket + " connection from " + srcAndPort);
            socket.pendingConnections.push(srcAndPort); // TODO: limit number of pending connections to backlog
            socket.status = this.Socket_Connected;
            socket._signalConnSemaphore();
            // now subscribe to receive data
            var connection = srcAndPort + "-" + ipAndPort;
            socket.connection = connection; // remember for easy unsubscribe
            network.subscribe(connection, "tcp-sent", function (data) {
              DEBUG > 0 && console.log("Croquet network: " + socket + " received " + data.length + " bytes from " + srcAndPort);
              socket.response = [data];
              socket.responseReceived = true;
              socket._signalReadSemaphore();
            }.bind(this));
            network.subscribe(connection, "tcp-disconnected-src", function () {
              DEBUG > 0 && console.log("Croquet network: " + socket + " closed connection from " + srcAndPort);
              socket.status = this.Socket_OtherEndClosed;
              socket._signalConnSemaphore();
            }.bind(this));
          }.bind(this));
        } else {
          function udpReceive(data) {
            DEBUG > 0 && console.log("Croquet network: " + socket + " received " + data.length + " bytes");
            socket.response = [data];
            socket.responseReceived = true;
            socket._signalReadSemaphore();
          };
          udpReceive = udpReceive.bind(this);
          var broadcastAddrAndPort = BROADCAST_ADDR + ":" + port;
          udpReceive = udpReceive.bind(this);
          DEBUG > 2 && console.log("View.publish(" + ip + ", udp-listen, { " + ip + ", " + port + " })");
          network.publish(ip, "udp-listen", { ip, port });
          network.subscribe(ipAndPort, "udp-sent", udpReceive);
          network.subscribe(broadcastAddrAndPort, "udp-sent", udpReceive);
        }
      }.bind(this));
      return true;
    },

    croquetAccept: function (socket, newSocket, src, port) {
      var acceptedPort = newSocket.allocatePort();
      if (!acceptedPort) return false;
      var localHost = this.croquetAddr;
      var srcAndPort = src + ":" + port;
      var dstAndPort = localHost + ":" + socket.localPort;
      var connection = srcAndPort + "-" + dstAndPort;
      newSocket.isCroquet = true;
      newSocket.hostAddress = src.split(".").map(function (s) { return +s; });
      newSocket.port = port;
      newSocket.listenSocket = socket;
      newSocket.status = this.Socket_Connected;
      newSocket.sendIsReply = true;
      newSocket.connection = connection;
      this.withCroquetNetworkDo(function (network) {
        DEBUG > 0 && console.log("Croquet network: " + socket + " accepted connection from " + srcAndPort);
        network.subscribe(connection, "tcp-sent", function (data) {
          DEBUG > 0 && console.log("Croquet network: " + newSocket + " received " + data.length + " bytes from " + srcAndPort);
          newSocket.response = [data];
          newSocket.responseReceived = true;
          newSocket._signalReadSemaphore();
        }.bind(this));
        network.subscribe(connection, "tcp-disconnected-dst", function () {
          DEBUG > 0 && console.log("Croquet network: " + newSocket + " closed connection from " + srcAndPort);
          newSocket.status = this.Socket_OtherEndClosed;
          newSocket._signalConnSemaphore();
        }.bind(this));
      }.bind(this));
      return true;
    },

    croquetConnect: function (socket, hostAddr, port) {
      socket.isCroquet = true;
      this.withCroquetNetworkDo(function (network) {
        var localPort = socket.allocatePort();
        var src = this.croquetAddr;
        var dst = hostAddr.join(".");
        var srcAndPort = src + ":" + localPort;
        var dstAndPort = dst + ":" + port;
        DEBUG > 0 && console.log("Croquet network: " + socket + " connecting " + srcAndPort + " to " + dstAndPort);
        socket.status = this.Socket_WaitingForConnection;
        socket._signalConnSemaphore();

        function connect() {
          if (socket.status === this.Socket_WaitingForConnection) {
            DEBUG > 2 && console.log("View.publish(" + dstAndPort + ":tcp-connect, { " + srcAndPort + ", " + dstAndPort + " })");
            network.publish(dstAndPort, "tcp-connect", { srcAndPort, dstAndPort });
            setTimeout(connect, 100);
          }
        }
        connect = connect.bind(this);
        connect();

        var connection = srcAndPort + "-" + dstAndPort;
        socket.connection = connection; // remember for easy unsubscribe
        network.subscribe(connection, "tcp-connected-dst", function () {
          DEBUG > 0 && console.log("Croquet network: " + socket + " connected to " + dstAndPort);
          socket.status = this.Socket_Connected;
          socket._signalConnSemaphore();
          socket._signalWriteSemaphore(); // now ready to write
          // now subscribe to receive data
          network.subscribe(connection, "tcp-replied", function (data) {
            DEBUG > 0 && console.log("Croquet network: " + socket + " received " + data.length + " bytes from " + dstAndPort);
            socket.response = [data];
            socket.responseReceived = true;
            socket._signalReadSemaphore();
          }.bind(this));
        }.bind(this));
        network.subscribe(connection, "tcp-disconnected-dst", function ({ msg }) {
          if (socket.status === this.Socket_WaitingForConnection) {
            DEBUG > 0 && console.log("Croquet network: " + socket + " failed to connect " + srcAndPort + " to " + dstAndPort + ": " + msg);
          } else {
            DEBUG > 0 && console.log("Croquet network: " + socket + " disconnected " + dstAndPort + " from " + srcAndPort + ": " + msg);
          }
          socket.status = this.Socket_OtherEndClosed;
          socket._signalConnSemaphore();
        }.bind(this));
      }.bind(this));
      return true;
    },

    croquetClose: function (socket) {
      if (!socket.isCroquet) return false;
      this.withCroquetNetworkDo(function (network) {
        DEBUG > 0 && console.log("Croquet network: " + socket + " closing");
        var ip = this.croquetAddr;
        var port = socket.localPort;
        var ipAndPort = ip + ":" + port;
        if (socket.type === this.TCP_Socket_Type) {
          if (socket.listening) {
            network.unsubscribe(ipAndPort, "tcp-connected-src", "*");
            DEBUG > 2 && console.log("View.publish(" + ip + ":tcp-unlisten, { " + ip + ", " + port + " })");
            network.publish(ipAndPort, "tcp-unlisten", { ip, port });
            socket.listening = false;
          }
          if (socket.connection) {
            var connection = socket.connection;
            if (socket.sendIsReply) {
              network.unsubscribe(connection, "tcp-sent", "*");
              network.unsubscribe(connection, "tcp-disconnected-src", "*");
            } else {
              network.unsubscribe(connection, "tcp-replied", "*");
              network.unsubscribe(connection, "tcp-connected-dst", "*");
              network.unsubscribe(connection, "tcp-disconnected-dst", "*");
            }
            var [srcAndPort, dstAndPort] = connection.split("-");
            DEBUG > 2 && console.log("View.publish(" + connection + ":tcp-close, { " + srcAndPort + ", " + dstAndPort + " })");
            network.publish(connection, "tcp-close", { srcAndPort, dstAndPort });
            socket.connection = null;
          }
        } else { // UDP
          if (socket.listening) {
            network.unsubscribe(ipAndPort, "udp-sent", "*");
            DEBUG > 2 && console.log("View.publish(" + ipAndPort + ", udp-unlisten, { " + ip + ", " + port + " })");
            network.publish(ipAndPort, "udp-unlisten", { ip, port });
            socket.listening = false;
          }
        }
        console.log(CROQUETVD.subscriptions);
      }.bind(this));
      return true;
    },

    croquetDestroy: function (socket) {
      if (!socket.isCroquet) return false;
      DEBUG > 0 && console.log("Croquet network: " + socket + " destroying");
      if (socket.status !== this.Socket_Unconnected) {
        this.croquetClose(socket);
      }
      socket.status = this.Socket_InvalidSocket;
      socket._signalConnSemaphore();
      return true;
    },

    croquetTCPSend: function (socket, data, start, end) {
      var count = end - start;
      if (start > 0 || count !== data.length) data = data.subarray(start, end);
      this.withCroquetNetworkDo(function send(network) {
        var srcAndPort, dstAndPort, connection;
        if (socket.sendIsReply) {
          if (!socket.hostAddress) socket.connectPending();
          srcAndPort = socket.hostAddress.join(".") + ":" + socket.port;
          dstAndPort = this.croquetAddr + ":" + socket.localPort;
          connection = srcAndPort + "-" + dstAndPort;
          DEBUG > 0 && console.log("Croquet network: " + socket + " reply " + data.length + " bytes");
          DEBUG > 2 && console.log("View.publish(" + connection + ":tcp-reply, { " + srcAndPort + ", " + dstAndPort + ", " + data.length + " bytes })");
          network.publish(connection, "tcp-reply", { srcAndPort, dstAndPort, data });
        } else {
          srcAndPort = this.croquetAddr + ":" + socket.localPort;
          dstAndPort = socket.hostAddress.join(".") + ":" + socket.port;
          connection = srcAndPort + "-" + dstAndPort;
          DEBUG > 0 && console.log("Croquet network: " + socket + " send " + data.length + " bytes");
          DEBUG > 2 && console.log("View.publish(" + connection + ":tcp-send, { " + srcAndPort + ", " + dstAndPort + ", " + data.length + " bytes })");
          network.publish(connection, "tcp-send", { srcAndPort, dstAndPort, data });
        }
        this.lastCroquetSend = Date.now();
      }.bind(this));
      return count;
    },

    croquetUDPSend: function (socket, data, start, end, address, port) {
      var count = end - start;
      if (start > 0 || count !== data.length) data = data.subarray(start, end);
      var dst = address.join(".");
      var dstAndPort = dst + ":" + port;
      this.withCroquetNetworkDo(function send(network) {
        DEBUG > 0 && console.log("Croquet network: " + socket + " send " + data.length + " bytes");
        DEBUG > 2 && console.log("View.publish(" + dstAndPort + ", udp-send, { " + dstAndPort + ", " + data.length + " bytes })");
        network.publish(dstAndPort, "udp-send", { dstAndPort, data });
        this.lastCroquetSend = Date.now();
      }.bind(this));
      return count;
    },

    lastCroquetSend: 0,

    croquetSendDone: function (socket) {
      if (!this.croquetNetwork) return true;
      var msSinceLastSend = Date.now() - this.lastCroquetSend;
      var wait = CROQUET_RATE_LIMIT - msSinceLastSend;
      DEBUG > 2 && wait > 0 && console.log("Croquet network: send limit wait time " + (CROQUET_RATE_LIMIT - msSinceLastSend) + "ms");
      return wait <= 0;
    },

    withCroquetNetworkDo: function (func) {
      // call func with the local NetworkParticipantView instance
      if (this.croquetNetwork) {
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
        this.startCroquetNetwork()
          .then(session => {
            this.croquetNetwork = session;
            var ip = session.view.ip;
            this.croquetAddress = ip.split(".").map(function (s) { return +s; });
            this.croquetAddr = ip;
            func(this.croquetNetwork.view);
            continueExecution();
          }).catch(error => {
            console.error("Failed to join Croquet session", error);
            continueExecution();
          });
      });
    },

    /****************************************************************
     * Initially this plugin assumes it will only be used for http
     * requests, which are handled by fetch() / XMLHttpRequest.
     * We only load Croquet when we need it, which typically is indicated
     * by the image requesting to know our local IP address. We allocate
     * an IP by connecting to the Croquet session below - every Croquet
     * View gets its own IP address, and we treat its viewId as the host
     * name.
     * Then when a socket is listening, or connecting to one of our
     * virtual LAN addresses (10.42.*.*), we mark it as a Croquet socket.
     * When a socket starts listening, it will register itself with the
     * Croquet network, which keeps a list of listening ports for each host.
     * The network model will subscribe to messages addressed to these ports,
     * and re-publish them, so the subscribed socket can receive them.
     *
     * Event scopes:
     *   scope "network" / session:
     *       about the network itself, e.g. hosts joining
     *   scope ip (e.g. "10.42.0.1"):
     *       regarding a specific host
     *   scope ipAndPort (e.g. "10.42.0.1:1024"):
     *       regarding a specific port
     *   scope connection (e.g. "10.42.0.1:1024-10.42.0.2:3456"):
     *       for a specific connection between two ports (TCP only)
     *
     * Events:
     *   ==> means published by network, subscribed by host
     *   <== means published by host, subscribed by network
     *
     *   <== session "view-join" (hostName)
     *   <== session "view-exit" (hostName)
     *   ==> "network" "ip-allocated" ({hostName, ip})
     *   ==> "network" "ip-released" ({hostName, ip})
     *
     *   <== ip "udp-listen" ({ip, port})
     *   <== ipAndPort "udp-unlisten" ({ip, port})
     *   <== ipAndPort "udp-send" ({dstAndPort, data})
     *   ==> ipAndPort "udp-sent" (data)
     *
     *   <== ip "tcp-listen" ({ip, port})
     *   <== ipAndPort "tcp-unlisten" ({ip, port})
     *   <== ipAndPort "tcp-connect" ({srcAndPort, dstAndPort})
     *   ==> ipAndPort "tcp-connected-src" (srcAndPort)
     *   ==> connection "tcp-connected-dst" ()
     *   <== connection "tcp-send" ({srcAndPort, dstAndPort, data})
     *   ==> connection "tcp-sent" (data)
     *   <== connection "tcp-reply" ({srcAndPort, dstAndPort, data})
     *   ==> connection "tcp-replied" (data)
     *   <== connection "tcp-close" ({srcAndPort, dstAndPort})
     *   ==> connection "tcp-disconnected-src" (msg)
     *   ==> connection "tcp-disconnected-dst" (msg)
     */

    croquetPromise: null,
    sessionPromise: null,

    startCroquetNetwork: async function () {
      // load Croquet only once (and only if we need it)
      if (!this.croquetPromise) this.croquetPromise = new Promise(resolve => {
        if (window.Croquet) resolve(); // already loaded
        else {
          const script = document.createElement("script");
          script.src = CROQUET_URL;
          document.head.appendChild(script);
          script.onload = resolve;
        }
      });

      await this.croquetPromise; // wait for Croquet to load

      // the shared network, syncronized by Croquet
      class NetworkModel extends Croquet.Model {
        init(options) {
          super.init(options);
          this.hostNames = new Map(); // host name (viewId) => host
          this.ipAddresses = new Map(); // ip addr => host
          this.nextIp = 1;
          this.udpBroadcasts = new Map(); // port => number of hosts listening
          this.subscribe(this.sessionId, "view-join", this.hostJoined);
          this.subscribe(this.sessionId, "view-exit", this.hostExited);
        }

        hostJoined(hostName) {
          // allocate an IP address for the new participant
          // TODO: keep mapping for a certain time even if
          // participant goes away, à la DHCP
          let i = this.nextIp;
          let ip;
          let addr = [10, 42, 0, 0]; // we use 10.42.*.* for the IP addresses
          do {
            addr[2] = i >> 8;
            addr[3] = i & 0xFF;
            ip = addr.join(".");
            if (++i > 0xFFFF) i = 1; // wrap around, skipping 0
            if (i === this.nextIp) throw new Error("Too many participants"); // unlikely
          } while (this.ipAddresses.has(ip));
          this.nextIp = i;
          // found an unused IP address
          DEBUG > 1 && console.log("@" + this.now() + " host joined: " + hostName + " => " + ip);
          const host = {
            ip,
            tcpPorts: new Map(), // port => connections
            udpPorts: new Set(), // port
          }
          this.ipAddresses.set(ip, host);
          this.hostNames.set(hostName, host);
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(network, ip-allocated, { " + hostName + ", " + ip + " })");
          this.publish("network", "ip-allocated", { hostName, ip });
          this.subscribe(ip, "tcp-listen", this.tcpListen);
          this.subscribe(ip, "udp-listen", this.udpListen);
        }

        hostExited(hostName) {
          const host = this.hostNames.get(hostName);
          DEBUG > 1 && console.log("@" + this.now() + " host exited: " + hostName + " (" + host.ip + ")");
          this.ipAddresses.delete(host.ip);
          this.hostNames.delete(hostName);
          this.unsubscribe(host.ip, "tcp-listen", "*");
          this.unsubscribe(host.ip, "udp-listen", "*");
          for (const port of host.tcpPorts.keys()) {
            this.tcpUnsubscribe(host, port);
          }
          for (const port of host.udpPorts) {
            this.udpUnsubscribe(host, port);
          }
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(network, ip-released, { " + hostName + ", " + host.ip + " })");
          this.publish("network", "ip-released", { hostName, ip: host.ip });
        }

        udpUnsubscribe(host, port) {
          if (!host.udpPorts.has(port)) return; // not listening
          host.udpPorts.delete(port);
          // for udp we just care about sends ...
          const ipAndPort = host.ip + ":" + port;
          this.unsubscribe(ipAndPort, "udp-send", "*");
          this.unsubscribe(ipAndPort, "udp-unlisten", "*");
          // ... and broadcasts
          let count = this.udpBroadcasts.get(port);
          this.udpBroadcasts.set(port, --count);
          if (count === 0) {
            const broadcastAddrAndPort = BROADCAST_ADDR + ":" + port;
            this.unsubscribe(broadcastAddrAndPort, "udp-send", "*");
            this.udpBroadcasts.delete(port);
          }
        }

        udpListen({ ip, port }) {
          DEBUG > 1 && console.log("@" + this.now() + " got udp listen " + ip + ":" + port);
          // a host started to listen on a udp port
          const host = this.ipAddresses.get(ip);
          if (!host) return;
          if (host.udpPorts.has(port)) return; // already listening
          host.udpPorts.add(port);
          // for udp we just care about sends ...
          const ipAndPort = ip + ":" + port;
          this.subscribe(ipAndPort, "udp-send", this.udpSend);
          this.subscribe(ipAndPort, "udp-unlisten", this.udpUnlisten);
          // ... and broadcasts
          let count = this.udpBroadcasts.get(port) || 0;
          this.udpBroadcasts.set(port, ++count);
          if (count === 1) {
            const broadcastAddrAndPort = BROADCAST_ADDR + ":" + port;
            this.subscribe(broadcastAddrAndPort, "udp-send", this.udpSend);
          }
        }

        udpUnlisten({ ip, port }) {
          DEBUG > 1 && console.log("@" + this.now() + " got udp unlisten " + ip + ":" + port);
          // a host stopped listening on a udp port
          const host = this.ipAddresses.get(ip);
          if (!host) return;
          this.udpUnsubscribe(host, port);
        }

        udpSend({ dstAndPort, data }) {
          DEBUG > 1 && console.log("@" + this.now() + " got udp send " + data.length + " bytes to " + dstAndPort);
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + dstAndPort + ", udp-sent, " + data.length + " bytes)");
          this.publish(dstAndPort, "udp-sent", data);
        }

        tcpListen({ ip, port }) {
          DEBUG > 1 && console.log("@" + this.now() + " got tcp listen " + ip + ":" + port);
          // a host started to listen on a tcp port
          const host = this.ipAddresses.get(ip);
          if (!host) return;
          if (host.tcpPorts.has(port)) return; // already listening
          // for tcp we keep track of connections
          const connections = new Set(); // srcAndPort
          host.tcpPorts.set(port, connections);
          const ipAndPort = ip + ":" + port;
          this.subscribe(ipAndPort, "tcp-connect", this.tcpConnect);
          this.subscribe(ipAndPort, "tcp-unlisten", this.tcpUnlisten);
        }

        tcpConnect({ srcAndPort, dstAndPort }) {
          DEBUG > 1 && console.log("@" + this.now() + " got tcp connect " + srcAndPort + " to " + dstAndPort);
          const connection = srcAndPort + "-" + dstAndPort;
          let [dst, port] = dstAndPort.split(":"); port = +port;
          const host = this.ipAddresses.get(dst);
          if (!host) {
            DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-disconnected-src, { msg: no such host " + dst + " })");
            this.publish(connection, "tcp-disconnected-src", { msg: "no such host " + dst });
            return;
          }
          const connections = host.tcpPorts.get(port);
          if (!connections) {
            DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-disconnected-src, { msg: no such port " + dstAndPort + " })");
            this.publish(connection, "tcp-disconnected-src", { msg: "no such port " + dstAndPort });
            return;
          }
          if (connections.has(srcAndPort)) {
            DEBUG > 1 && console.log("@" + this.now() + " ignoring (already connected)");
            return;
          }
          connections.add(srcAndPort);
          this.subscribe(connection, "tcp-send", this.tcpSend);
          this.subscribe(connection, "tcp-reply", this.tcpReply);
          this.subscribe(connection, "tcp-close", this.tcpClose);
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + dstAndPort + ":tcp-connected-src, " + srcAndPort + ")");
          this.publish(dstAndPort, "tcp-connected-src", srcAndPort);
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-connected-dst)");
          this.publish(connection, "tcp-connected-dst");
        }

        getConnection(srcAndPort, dstAndPort) {
          let [dst, port] = dstAndPort.split(":"); port = +port;
          const connection = srcAndPort + "-" + dstAndPort;
          var dstHost = this.ipAddresses.get(dst);
          if (!dstHost) {
            DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-disconnected-src, { msg: no such host " + dst + " })");
            this.publish(connection, "tcp-disconnected-src", { msg: "no such host " + dst });
            return;
          }
          const connections = dstHost.tcpPorts.get(port);
          if (!connections) {
            DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-disconnected-src, { msg: no such port " + dstAndPort + " })");
            this.publish(connection, "tcp-disconnected-src", { msg: "no such port " + dstAndPort });
            return;
          }
          if (!connections.has(srcAndPort)) {
            DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-disconnected-src, { msg: not connected to " + dstAndPort + " })");
            this.publish(connection, "tcp-disconnected-src", { msg: "not connected to " + dstAndPort });
            return;
          }
          return connection;
        }

        tcpSend({ srcAndPort, dstAndPort, data }) {
          DEBUG > 1 && console.log("@" + this.now() + " forwarding tcp send " + data.length + " bytes from " + srcAndPort + " to " + dstAndPort);
          let connection = this.getConnection(srcAndPort, dstAndPort, data);
          if (!connection) return;
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-sent, " + data.length + " bytes)");
          this.publish(connection, "tcp-sent", data);
        }

        tcpReply({ srcAndPort, dstAndPort, data }) {
          DEBUG > 1 && console.log("@" + this.now() + " forwarding tcp reply " + data.length + " bytes from " + srcAndPort + " to " + dstAndPort);
          let connection = this.getConnection(srcAndPort, dstAndPort, data);
          if (!connection) {
            this.publish(connection, "tcp-disconnected-dst", { msg: "not connected to " + srcAndPort });
            return;
          }
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-replied, " + data.length + " bytes)");
          this.publish(connection, "tcp-replied", data);
        }

        tcpUnsubscribePort(host, port) {
          const ipAndPort = host.ip + ":" + port;
          this.unsubscribe(ipAndPort, "tcp-connect", "*");
          this.unsubscribe(ipAndPort, "tcp-unlisten", "*");
          const connections = host.tcpPorts.get(port);
          if (connections) {
            for (const srcAndPort of connections) {
              const connection = srcAndPort + "-" + ipAndPort;
              this.tcpUnsubscribeConnection(connection);
            }
            host.tcpPorts.delete(port);
          }
        }

        tcpUnsubscribeConnection(connection) {
          this.unsubscribe(connection, "tcp-send", "*");
          this.unsubscribe(connection, "tcp-reply", "*");
          this.unsubscribe(connection, "tcp-close", "*");
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-disconnected-src, { msg: closed })");
          this.publish(connection, "tcp-disconnected-src", { msg: "closed" });
          DEBUG > 2 && console.log("@" + this.now() + " Model.publish(" + connection + ":tcp-disconnected-dst, { msg: closed })");
          this.publish(connection, "tcp-disconnected-dst", { msg: "closed" });
        }

        tcpClose({ srcAndPort, dstAndPort }) {
          let [dst, port] = dstAndPort.split(":"); port = +port;
          DEBUG > 1 && console.log("@" + this.now() + " got tcp close " + srcAndPort + " to " + dstAndPort);
          const host = this.ipAddresses.get(dst);
          if (!host) return;
          this.tcpUnsubscribeConnection(host, port);
        }

        tcpUnlisten({ ip, port }) {
          DEBUG > 1 && console.log("@" + this.now() + " got tcp unlisten " + ip + ":" + port);
          const host = this.ipAddresses.get(ip);
          if (!host) return;
          this.tcpUnsubscribePort(host, port);
        }
      }
      NetworkModel.register("NetworkModel");

      // the local network participant
      class NetworkParticipantView extends Croquet.View {
        constructor(model) {
          super(model);
          this.model = model;
          this.subscribe("network", "ip-allocated", this.ipAllocated);
          this.subscribe("network", "ip-released", this.ipReleased);
          console.log("Croquet network: local participant " + this.viewId + " got IP " + this.ip);
          console.log("Croquet network: " + this.model.hostNames.size + " participant" + (this.model.hostNames.size === 1 ? "" : "s"));
        }

        ipAllocated({ hostName, ip }) {
          console.log("Croquet network: allocated IP " + ip + " to participant " + hostName);
        }

        ipReleased({ hostName, ip }) {
          console.log("Croquet network: released IP " + ip + " from participant " + hostName);
        }

        get ip() {
          const host = this.model.hostNames.get(this.viewId);
          return host.ip;
        }
      }

      // start session
      if (!this.sessionPromise) {
        // to run this locally I use the URL
        // http://localhost:8000/jasmine/?apiKey=my-dev-key
        // because the public key is restricted to my github.io domain
        let apiKey = window.location.search.match(/apiKey=([^&]+)/);
        if (apiKey) apiKey = apiKey[1];
        else apiKey = "1bfHo0sk3HLmzqxiaasuEFBccxNDE660vMzghymFm";
        this.sessionPromise = Croquet.Session.join({
          apiKey, // get your own from https://croquet.io/keys
          appId: "net.codefrau.jasmine", // can be anything
          model: NetworkModel,
          view: NetworkParticipantView,
          name: "Jasmine",
          password: "Jasmine",
          debug: DEBUG > 2 && ["session", "subscribe"],
          tps: 0, // if there are no future messages we don't need ticks
        });
      }

      return this.sessionPromise;
    },
  };
}

function registerSocketPlugin() {
  if (typeof Squeak === "object" && Squeak.registerExternalModule) {
    Squeak.registerExternalModule('SocketPlugin', SocketPlugin());
  } else self.setTimeout(registerSocketPlugin, 100);
};

registerSocketPlugin();
