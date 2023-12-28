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

  var DEBUG = 0; // 0 = off, 1 = some, 2 = lots

  return {
    getModuleName: function() { return 'SocketPlugin (croquet)'; },
    interpreterProxy: null,
    primHandler: null,

    handleCounter: 0,
    needProxy: new Set(),

    // DNS Lookup
    // Cache elements: key is name, value is { address: 1.2.3.4, validUntil: Date.now() + 30000 }
    status: 0, // Resolver_Uninitialized,
    lookupCache: {
      localhost: { address: [ 127, 0, 0, 1], validUntil: Number.MAX_SAFE_INTEGER }
    },
    lastLookup: null,
    lookupSemaIdx: 0,

    // ports in use for listening
    ports: {},

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

    setInterpreter: function(anInterpreter) {
      this.interpreterProxy = anInterpreter;
      this.vm = anInterpreter.vm;
      this.primHandler = this.vm.primHandler;
      return true;
    },

    _signalSemaphore: function(semaIndex) {
      if (semaIndex <= 0) return;
      this.primHandler.signalSemaphoreWithIndex(semaIndex);
    },

    _signalLookupSemaphore: function() { this._signalSemaphore(this.lookupSemaIdx); },

    _getAddressFromLookupCache: function(name, skipExpirationCheck) {
      if (name) {

        // Check for valid dotted decimal name first
        var dottedDecimalsMatch = name.match(/^\d+\.\d+\.\d+\.\d+$/);
        if (dottedDecimalsMatch) {
          var result = name.split(".").map(function(d) { return +d; });
          if (result.every(function(d) { return d <= 255; })) {
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

    _addAddressFromResponseToLookupCache: function(response) {
      // Check for valid response
      if (!response || response.Status !== 0 || !response.Question || !response.Answer) {
        return;
      }

      // Clean up all response elements by removing trailing dots in names
      var removeTrailingDot = function(element, field) {
        if (element[field] && element[field].replace) {
          element[field] = element[field].replace(/\.$/, "");
        }
      };
      var originalQuestion = response.Question[0];
      removeTrailingDot(originalQuestion, "name");
      response.Answer.forEach(function(answer) {
        removeTrailingDot(answer, "name");
        removeTrailingDot(answer, "data");
      });

      // Get address by traversing alias chain
      var lookup = originalQuestion.name;
      var address = null;
      var ttl = 24 * 60 * 60; // One day as safe default
      var hasAddress = response.Answer.some(function(answer) {
        if (answer.name === lookup) {

          // Time To Live can be set on alias and address, keep shortest period
          if (answer.TTL) {
            ttl = Math.min(ttl, answer.TTL);
          }

          if (answer.type === 1) {
            // Retrieve IP address as array with 4 numeric values
            address = answer.data.split(".").map(function(numberString) { return +numberString; });
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
        this.lookupCache[originalQuestion.name] = { address: address, validUntil: Date.now() + (ttl * 1000) };
      }
    },

    _compareAddresses: function(address1, address2) {
      return address1.every(function(addressPart, index) {
        return address2[index] === addressPart;
      });
    },

    _reverseLookupNameForAddress: function(address) {
      // Currently public API's for IP to hostname are not standardized yet (like DoH).
      // Assume most lookup's will be for reversing earlier name to address lookups.
      // Therefor use the lookup cache and otherwise create a dotted decimals name.
      var result = null;
      Object.keys(this.lookupCache).some(function(name) {
        if (this._compareAddresses(address, this.lookupCache[name].address)) {
          result = name;
          return true;
        }
        return false;
      }.bind(this));
      return result || address.join(".");
    },

    // A socket emulates socket behavior
    _newSocket: function(domain, socketType, rcvBufSize, sendBufSize, connSemaIdx, readSemaIdx, writeSemaIdx) {
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

        _signalConnSemaphore: function() { plugin._signalSemaphore(this.connSemaIndex); DEBUG > 0 && console.log("Signaled conn semaphore: " + this);},
        _signalReadSemaphore: function() { plugin._signalSemaphore(this.readSemaIndex); DEBUG > 0 && console.log("Signaled read semaphore: " + this);},
        _signalWriteSemaphore: function() { plugin._signalSemaphore(this.writeSemaIndex); DEBUG > 0 && console.log("Signaled write semaphore: " + this);},

        _otherEndClosed: function() {
          this.status = plugin.Socket_OtherEndClosed;
          this.webSocket = null;
          this._signalConnSemaphore();
          DEBUG > 0 && console.log("Socket status: " + this);
        },

        _hostAndPort: function() { return this.host + ':' + this.port; },

        _requestNeedsProxy: function() {
          return plugin.needProxy.has(this._hostAndPort());
        },

        _getURL: function(targetURL, isRetry) {
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

        _performRequest: function() {
          // Assume a send is requested through WebSocket if connection is present
          if (this.webSocket) {
            this._performWebSocketSend();
            return;
          }

          var request = new TextDecoder("utf-8").decode(this.sendBuffer);

          // Remove request from send buffer
          var endOfRequestIndex = this.sendBuffer.findIndex(function(element, index, array) {
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

        _performFetchAPIRequest: function(targetURL, httpMethod, data, requestLines) {
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
            .then(function(res) {
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

        _handleFetchAPIResponse: function(res) {
          if (this.response === null) {
            var header = ['HTTP/1.0 ', res.status, ' ', res.statusText, '\r\n'];
            res.headers.forEach(function(value, key, array) {
              header = header.concat([key, ': ', value, '\r\n']);
            });
            header.push('\r\n');
            this.response = [new TextEncoder('utf-8').encode(header.join(''))];
          }
          this._readIncremental(res.body.getReader());
        },

        _readIncremental: function(reader) {
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

        _performXMLHTTPRequest: function(targetURL, httpMethod, data, requestLines){
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

          httpRequest.onerror = function(e) {
            var url = thisSocket._getURL(targetURL, true);
            console.warn('Retrying with CORS proxy: ' + url);
            var retry = new XMLHttpRequest();
            retry.open(httpMethod, url);
            retry.responseType = httpRequest.responseType;
            if (typeof SqueakJS === "object" && SqueakJS.options.ajaxx) {
                retry.setRequestHeader("X-Requested-With", "XMLHttpRequest");
            }
            retry.onload = function(oEvent) {
              console.log('Success: ' + url);
              thisSocket._handleXMLHTTPResponse(this);
              plugin.needProxy.add(thisSocket._hostAndPort());
            };
            retry.onerror = function() {
              thisSocket._otherEndClosed();
              console.error("Failed to download:\n" + url);
            };
            retry.send(data);
          };

          httpRequest.send(data);
        },

        _handleXMLHTTPResponse: function(response) {
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

        _performWebSocketRequest: function(targetURL, httpMethod, data, requestLines){
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
          this.webSocket.onopen = function() {
            if (thisSocket.status !== plugin.Socket_Connected) {
              thisSocket.status = plugin.Socket_Connected;
              thisSocket._signalConnSemaphore();
              thisSocket._signalWriteSemaphore(); // Immediately ready to write
              DEBUG > 0 && console.log("Socket status: " + this);
            }

            // Send the (fake) handshake back to the caller
            var acceptKey = new Uint8Array(sha1.array(webSocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            var acceptKeyString = Squeak.bytesAsString(acceptKey);
            thisSocket._performWebSocketReceive(
              "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Accept: " + btoa(acceptKeyString) + "\r\n\r\n",
               true
            );
          };
          this.webSocket.onmessage = function(event) {
            thisSocket._performWebSocketReceive(event.data);
          };
          this.webSocket.onerror = function(e) {
            thisSocket._otherEndClosed();
            console.error("Error in WebSocket:", e);
          };
          this.webSocket.onclose = function() {
            thisSocket._otherEndClosed();
          };
        },

        _performWebSocketReceive: function(message, skipFramePacking) {

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
            this.response = [ message ];
          } else {
            this.response.push(message);
          }
          this.responseReceived = true;
          this._signalReadSemaphore();
        },

        _performWebSocketSend: function() {
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
            payloadData = payloadData.map(function(b, index) { return b ^ maskKey[index & 0x03]; });
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

        connect: function(hostAddress, port) {
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
          DEBUG > 0 && console.log("Socket status: " + this);
        },

        close: function() {
          if (this.status == plugin.Socket_Connected ||
              this.status == plugin.Socket_OtherEndClosed ||
              this.status == plugin.Socket_WaitingForConnection) {
            if(this.webSocket) {
              this.webSocket.close();
              this.webSocket = null;
            }
            this.status = plugin.Socket_Unconnected;
            this._signalConnSemaphore();
            DEBUG > 0 && console.log("Socket status: " + this);
          }
        },

        destroy: function() {
          this.status = plugin.Socket_InvalidSocket;
          DEBUG > 0 && console.log("Socket status: " + this);
        },

        dataAvailable: function() {
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
                DEBUG > 0 && console.log("Socket status: " + this);
              }
            }
          }
          return false;
        },

        recv: function(count) {
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
          if (this.responseReceived && this.response.length === 0 && !this.webSocket) {
            this.responseSentCompletly = true;
          }

          return data;
        },

        send: function(data, start, end) {
          if (this.isCroquet) return plugin.croquetSend(this, data, start, end);
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

        sendUDP: function(data, start, end, address, port) {
          if (this.isCroquet) return plugin.croquetSendUDP(this, data, start, end, address, port);
          console.warn("UDP not supported");
          return 0;
        },

        listen: function(port, backlog) {
          if (this.status !== plugin.Socket_Unconnected && this.type !== plugin.UDP_Socket_Type) {
            console.warn("Croquet network: socket is already connected");
            return false;
          }
          if (plugin.ports[port]) {
            console.warn("Croquet network: port " + port + " is already in use");
            return false;
          }
          if (!port) for (port = 1024; port < 65536; port++) {
            if (!plugin.ports[port]) break;
          }
          if (port > 65535) {
            console.warn("Croquet network: no free port found");
            return false;
          }
          plugin.ports[port] = this;
          this.localPort = port;
          this.listenBacklog = backlog;

          plugin.croquetListen(this, port, backlog);

          return true;
        },

        [Symbol.toPrimitive]: function() {
          var name = this.name || "socket";
          var details = "";
          if (this.isCroquet) details += " Croquet";
          if (this.type === plugin.TCP_Socket_Type) details += " TCP";
          else if (this.type === plugin.UDP_Socket_Type) details += " UDP";
          if (this.localPort) details += " listening on: " + this.localPort;
          if (this.host) details += " remote: " + this.host + ":" + this.port;
          if (this.status !== plugin.Socket_Unconnected || !details) details += " (" + this.statusString() + ")";
          return name + "[" + details.trim() + "]";
        },

        statusString: function() {
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

    primitiveHasSocketAccess: function(argCount) {
      DEBUG > 0 && console.log("primitiveHasSocketAccess");
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.trueObject());
      return true;
    },

    primitiveInitializeNetwork: function(argCount) {
      DEBUG > 0 && console.log("primitiveInitializeNetwork");
      if (argCount !== 1) return false;
      this.lookupSemaIdx = this.interpreterProxy.stackIntegerValue(0);
      this.status = this.Resolver_Ready;
      this.interpreterProxy.pop(argCount); // Answer self
      return true;
    },

    primitiveResolverNameLookupResult: function(argCount) {
      DEBUG > 0 && console.log("primitiveResolverNameLookupResult");
      if (argCount !== 0) return false;

      // Validate that lastLookup is in fact a name (and not an address)
      if (!this.lastLookup || !this.lastLookup.substr) {
        this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
        return true;
      }

      // Retrieve result from cache
      var address = this._getAddressFromLookupCache(this.lastLookup, true);
      this.interpreterProxy.popthenPush(argCount + 1, address ?
        this.primHandler.makeStByteArray(address) :
        this.interpreterProxy.nilObject()
      );
      return true;
    },

    primitiveResolverStartNameLookup: function(argCount) {
      DEBUG > 0 && console.log("primitiveResolverStartNameLookup");
      if (argCount !== 1) return false;

      // Start new lookup, ignoring if one is in progress
      var lookup = this.lastLookup = this.interpreterProxy.stackValue(0).bytesAsString();

      // Perform lookup in local cache
      var result = this._getAddressFromLookupCache(lookup, false);
      if (result) {
        this.status = this.Resolver_Ready;
        this._signalLookupSemaphore();
      } else {

        // Perform DNS request
        var dnsQueryURL = "https://9.9.9.9:5053/dns-query?name=" + encodeURIComponent(this.lastLookup) + "&type=A";
        var queryStarted = false;
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
            .then(function(response) {
              return response.json();
            })
            .then(function(response) {
              thisSocket._addAddressFromResponseToLookupCache(response);
            })
            .catch(function(error) {
              console.error("Name lookup failed", error);
            })
            .then(function() {

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
          var lookupReady = function() {

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
          httpRequest.onload = function(oEvent) {
            thisSocket._addAddressFromResponseToLookupCache(this.response);
            lookupReady();
          };
          httpRequest.onerror = function() {
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

    primitiveResolverAddressLookupResult: function(argCount) {
      DEBUG > 0 && console.log("primitiveResolverAddressLookupResult");
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

    primitiveResolverStartAddressLookup: function(argCount) {
      DEBUG > 0 && console.log("primitiveResolverStartAddressLookup");
      if (argCount !== 1) return false;

      // Start new lookup, ignoring if one is in progress
      this.lastLookup = this.interpreterProxy.stackBytes(0);
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());

      // Immediately signal the lookup is ready (since all lookups are done internally)
      this.status = this.Resolver_Ready;
      this._signalLookupSemaphore();

      return true;
    },

    primitiveResolverStatus: function(argCount) {
      DEBUG > 0 && console.log("primitiveResolverStatus");
      if (argCount !== 0) return false;
      this.interpreterProxy.popthenPush(argCount + 1, this.status);
      return true;
    },

    primitiveResolverAbortLookup: function(argCount) {
      DEBUG > 0 && console.log("primitiveResolverAbortLookup");
      if (argCount !== 0) return false;

      // Unable to abort send request (although future browsers might support AbortController),
      // just cancel the handling of the request by resetting the lastLookup value
      this.lastLookup = null;
      this.status = this.Resolver_Ready;
      this._signalLookupSemaphore();

      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    primitiveSocketRemoteAddress: function(argCount) {
      DEBUG > 0 && console.log("primitiveSocketRemoteAddress");
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      this.interpreterProxy.popthenPush(argCount + 1, socket.hostAddress ?
        this.primHandler.makeStByteArray(socket.hostAddress) :
        this.interpreterProxy.nilObject()
      );
      return true;
    },

    primitiveSocketRemotePort: function(argCount) {
      DEBUG > 0 && console.log("primitiveSocketRemotePort");
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      this.interpreterProxy.popthenPush(argCount + 1, socket.port);
      return true;
    },

    primitiveSocketConnectionStatus: function(argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      var status = socket.status;
      if (status === undefined) status = this.Socket_InvalidSocket;
      DEBUG > 1 && console.log("primitiveSocketConnectionStatus " + socket);
      this.interpreterProxy.popthenPush(argCount + 1, status);
      return true;
    },

    primitiveSocketConnectToPort: function(argCount) {
      if (argCount !== 3) return false;
      var socket = this.interpreterProxy.stackObjectValue(2).socket;
      if (socket === undefined) return false;
      var hostAddress = this.interpreterProxy.stackBytes(1);
      var port = this.interpreterProxy.stackIntegerValue(0);
      socket.connect(hostAddress, port);
      DEBUG > 0 && console.log("primitiveSocketConnectToPort " + socket);
      this.interpreterProxy.popthenPush(argCount + 1,
                                        this.interpreterProxy.nilObject());
      return true;
    },

    primitiveSocketCloseConnection: function(argCount) {
      DEBUG > 0 && console.log("primitiveSocketCloseConnection");
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      socket.close();
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    socketCreate: function(domain, socketType, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex) {
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

    primitiveSocketCreate: function(argCount) {
      // older version of primitiveSocketCreate3Semaphores that is
      // invoked if that primitve failed
      if (argCount !== 5) return false;
      var domain = this.interpreterProxy.stackObjectValue(4);
      var socketType = this.interpreterProxy.stackIntegerValue(3);
      var rcvBufSize = this.interpreterProxy.stackIntegerValue(2);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(1);
      var semaIndex = this.interpreterProxy.stackIntegerValue(0);
      var sqHandle = this.socketCreate(domain, socketType, rcvBufSize, sendBufSize, semaIndex, semaIndex, semaIndex);
      DEBUG > 0 && console.log("primitiveSocketCreate => " + sqHandle);
      if (!sqHandle) return false;
      this.interpreterProxy.popthenPush(argCount + 1, sqHandle);
    },

    primitiveSocketCreate3Semaphores: function(argCount) {
      if (argCount !== 7) return false;
      var domain = this.interpreterProxy.stackObjectValue(6);
      var socketType = this.interpreterProxy.stackIntegerValue(5);
      var rcvBufSize = this.interpreterProxy.stackIntegerValue(4);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(3);
      var semaIndex = this.interpreterProxy.stackIntegerValue(2);
      var readSemaIndex = this.interpreterProxy.stackIntegerValue(1);
      var writeSemaIndex = this.interpreterProxy.stackIntegerValue(0);
      var sqHandle = this.socketCreate(domain, socketType, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
      DEBUG > 0 && console.log("primitiveSocketCreate3Semaphores => " + sqHandle);
      if (!sqHandle) return false;
      this.interpreterProxy.popthenPush(argCount + 1, sqHandle);
      return true;
    },

    primitiveSocketDestroy: function(argCount) {
      DEBUG > 0 && console.log("primitiveSocketDestroy");
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      socket.destroy();
      this.interpreterProxy.popthenPush(argCount + 1, socket.status);
      return true;
    },

    primitiveSocketReceiveDataAvailable: function(argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      var dataAvailable = socket.dataAvailable();
      (DEBUG > 1 || dataAvailable) && console.log("primitiveSocketReceiveDataAvailable " + socket + " => " + ret);
      this.interpreterProxy.pop(argCount + 1);
      this.interpreterProxy.pushBool(dataAvailable);
      return true;
    },

    primitiveSocketReceiveDataBufCount: function(argCount) {
      DEBUG > 0 && console.log("primitiveSocketReceiveDataBufCount");
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var target = this.interpreterProxy.stackObjectValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      var count = this.interpreterProxy.stackIntegerValue(0);
      if ((start + count) > target.bytes.length) return false;
      var bytes = socket.recv(count);
      target.bytes.set(bytes, start);
      this.interpreterProxy.popthenPush(argCount + 1, bytes.length);
      return true;
    },

    primitiveSocketSendDataBufCount: function(argCount) {
      DEBUG > 0 && console.log("primitiveSocketSendDataBufCount");
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var data = this.interpreterProxy.stackObjectValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      if (start < 0 ) return false;
      var count = this.interpreterProxy.stackIntegerValue(0);
      var end = start + count;
      if (end > data.length) return false;

      var res = socket.send(data, start, end);
      this.interpreterProxy.popthenPush(argCount + 1, res);
      return true;
    },

    primitiveSocketSendDone: function(argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0).socket;
      if (socket === undefined) return false;
      var done = true;
      if (socket.isCroquet) done = this.croquetSendDone(socket);
      DEBUG > 0 && console.log("primitiveSocketSendDone " + socket + " => " + done);
      this.interpreterProxy.pop(argCount + 1);
      this.interpreterProxy.pushBool(done);
      return true;
    },

    primitiveSocketSendUDPDataBufCount: function(argCount) {
      DEBUG > 0 && console.log("primitiveSocketSendUDPDataBufCount");
      if (argCount !== 6) return false;
      var socket = this.interpreterProxy.stackObjectValue(5).socket;
      if (socket === undefined) return false;
      var data = this.interpreterProxy.stackObjectValue(4).bytes;
      if (!data) return false;
      var host = this.interpreterProxy.stackObjectValue(3).bytes;
      if (!host || host.length !== 4) return false;
      var port = this.interpreterProxy.stackIntegerValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      if (start < 0 ) return false;
      var count = this.interpreterProxy.stackIntegerValue(0);
      var end = start + count;
      if (end > data.length) return false;

      var res = socket.sendUDP(data, start, end, host, port);
      this.interpreterProxy.popthenPush(argCount + 1, res);
      return true;
    },

    /****************** CROQUET STUFF ******************/

    primitiveSocketListenWithOrWithoutBacklog: function(argCount) {
      if (argCount < 2) return false;
      var socket = this.interpreterProxy.stackObjectValue(argCount - 1).socket;
      if (socket === undefined) return false;
      var portNumber = this.interpreterProxy.stackIntegerValue(argCount - 2);
      if (portNumber < 0 || portNumber > 65535) return false;
      var backlog = 0;
      if (argCount > 2) {
        backlog = this.interpreterProxy.stackIntegerValue(argCount - 3);
      }
      var success = socket.listen(portNumber, backlog);
      if (!success) {
        DEBUG > 0 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket + " => failed");
        return false;
      }
      DEBUG > 0 && console.log("primitiveSocketListenWithOrWithoutBacklog " + socket, portNumber, backlog);
      this.interpreterProxy.pop(argCount);
      return true;
    },

    // primitiveSocketAccept3Semaphores: function(argCount) {
    //   debugger
    //   if (argCount !== 6) return false;
    //   var socket = this.interpreterProxy.stackObjectValue(5).socket;
    //   if (socket === undefined) return false;
    //   var rcvBufSize = this.interpreterProxy.stackIntegerValue(4);
    //   var sendBufSize = this.interpreterProxy.stackIntegerValue(3);
    //   var semaIndex = this.interpreterProxy.stackIntegerValue(2);
    //   var readSemaIndex = this.interpreterProxy.stackIntegerValue(1);
    //   var writeSemaIndex = this.interpreterProxy.stackIntegerValue(0);
    //   var newSocket = this.socketCreate(socket.type, rcvBufSize, sendBufSize, semaIndex, readSemaIndex, writeSemaIndex);
    //   newSocket.listenSocket = socket;
    //   DEBUG > 0 && console.log("primitiveSocketAccept3Semaphores " + socket + " => " + newSocket);
    //   this.interpreterProxy.popthenPush(argCount + 1, newSocket);
    //   return true;
    // },

    primitiveSocketAccept: function(argCount) {
      debugger
      if (argCount !== 4) return false;
      var socket = this.interpreterProxy.stackObjectValue(3).socket;
      if (socket === undefined) return false;
      var rcvBufSize = this.interpreterProxy.stackIntegerValue(2);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(1);
      var semaIndex = this.interpreterProxy.stackIntegerValue(0);
      var newSocket = this.socketCreate(socket.domain, socket.type, rcvBufSize, sendBufSize, semaIndex, semaIndex, semaIndex);
      if (!newSocket) return false;
      newSocket.listenSocket = socket;
      DEBUG > 0 && console.log("primitiveSocketAccept " + socket + " => " + newSocket);
      this.interpreterProxy.popthenPush(argCount + 1, newSocket);
      return true;
    },

    primitiveSocketLocalPort: function(argCount) {
      if (argCount !== 1) return false;
      var socket = this.interpreterProxy.stackObjectValue(0);
      var socket = socket.socket;
      if (socket === undefined) return false;
      var localPort = socket.localPort || 0;
      DEBUG > 0 && console.log("primitiveSocketLocalPort " + socket, localPort);
      this.interpreterProxy.popthenPush(argCount + 1, localPort);
    },

    primitiveSocketSetOptions: function(argCount) {
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
          DEBUG > 0 && console.log("primitiveSocketSetOptions " + socket + " SO_BROADCAST " + value);
          break;
        default: DEBUG > 0 && console.warn("primitiveSocketSetOptions: unknown option " + options);
      }
      var resultArray = this.interpreterProxy.instantiateClassindexableSize(this.interpreterProxy.classArray(), 2);
      resultArray.pointers[0] = 0;
      resultArray.pointers[1] = 0;
      this.interpreterProxy.popthenPush(argCount + 1, resultArray);
    },

    primitiveResolverLocalAddress: function(argCount) {
      DEBUG > 0 && console.log("primitiveResolverLocalAddress ...");
      if (argCount !== 0) return false;
      var localAddressOop = this.interpreterProxy.instantiateClassindexableSize(this.interpreterProxy.classByteArray(), 4);

      // this call may freeze the VM if there is no network session yet,
      // meaning we execute the popthenPush below and pause execution
      // until the session is established.
      // Then we can fill in the address and continue execution.
      this.withCroquetNetworkDo(function(network) {
        var croquetAddress = network.ipAddress.split(".").map(function(s) { return +s; });
        for (var i = 0; i < 4; i++) {
          localAddressOop.bytes[i] = croquetAddress[i];
        }
        DEBUG > 0 && console.log("primitiveResolverLocalAddress => " + localAddressOop.bytes.join("."));
        this.croquetAddress = croquetAddress;
      }.bind(this));

      this.interpreterProxy.popthenPush(argCount + 1, localAddressOop);
      return true;
    },

    croquetListen: function(socket, port) {
      socket.isCroquet = true;
      this.withCroquetNetworkDo(function(network) {
        var ip = this.croquetAddress.join(".");
        var ipAndPort = ip + ":" + port;
        var tcp = socket.type === this.TCP_Socket_Type;
        console.log("Croquet network: " + (tcp ? "TCP" : "UDP") + " asking to listen on " + ipAndPort);
        network.publish(ip, "listen", {ip, port, tcp});
        network.subscribe(ipAndPort, "listening", function() {
          console.log("Croquet network: "+ (tcp ? "TCP" : "UDP") + " listening on " + ipAndPort);
          if (tcp) {
            socket.status = this.Socket_WaitingForConnection;
            socket._signalConnSemaphore();
          }
        }.bind(this));
      }.bind(this));
    },

    croquetConnect: function(socket, hostAddr, port) {
      socket.isCroquet = true;
      this.withCroquetNetworkDo(function(network) {
        var src = this.croquetAddress.join(".");
        var dst = hostAddr.join(".");
        var dstAndPort = dst + ":" + port;
        console.log("Croquet network: TCP connecting " + src + " to " + dstAndPort);
        network.publish(dstAndPort, "tcp-connect", {src, dst, port});
        socket.status = this.Socket_WaitingForConnection;
        socket._signalConnSemaphore();
        var connectionId = src + "-" + dstAndPort;
        network.subscribe(connectionId, "tcp-connected", function() {
          console.log("Croquet network: connected " + src + " to " + dstAndPort);
          socket.status = this.Socket_Connected;
          socket._signalConnSemaphore();
          socket._signalWriteSemaphore(); // now ready to write
        }.bind(this));
        network.subscribe(connectionId, "tcp-disconnected", function() {
          if (socket.status === this.Socket_WaitingForConnection) {
            console.log("Croquet network: failed to connect " + src + " to " + dstAndPort);
          } else {
            console.log("Croquet network: disconnected " + src + " from " + dstAndPort);
          }
          socket.status = this.Socket_OtherEndClosed;
          socket._signalConnSemaphore();
        }.bind(this));
      }.bind(this));
    },

    croquetSend: function(socket, data, start, end) {
      var src = this.croquetAddress.join(".");
      var dst = socket.hostAddress.join(".");
      var port = socket.port;
      var connectionId = src + "-" + dst + ":" + port;
      this.withCroquetNetworkDo(function send(network) {
        console.log("Croquet network: TCP send " + data.length + " bytes from " + src + " to " + dst + ":" + port);
        network.publish(connectionId, "tcp-send", data);
      }.bind(this));
      return end - start;
    },

    croquetSendUDP: function(socket, data, start, end, address, port) {
      var dst = address.join(".");
      var dstAndPort = dst + ":" + port;
      this.withCroquetNetworkDo(function send(network) {
        console.log("Croquet network: UDP send " + data.length + " bytes to " + address.join(".") + ":" + port);
        network.publish(dstAndPort, "udp-send", {dst, port, data});
      }.bind(this));
      return end - start;
    },

    croquetSendDone: function(socket) {
      if (!this.croquetNetwork) return true;
      // OMG ¯\_(ツ)_/¯
      return this.croquetNetwork.view.realm.vm.controller.connection.socket.bufferedAmount === 0;
      // TODO: properly expose buffered amount of websocket connection in Croquet
    },

    withCroquetNetworkDo: function(func) {
      // call func with the local NetworkParticipantView instance
      if (this.croquetNetwork) {
        func(this.croquetNetwork.view);
      } else this.vm.freeze(unfreeze => {
        // we need to freeze the VM until the session is established
        // so we can return the address
        function continueExecution() {
            if (unfreeze) unfreeze();
            unfreeze = null; // don't unfreeze twice
        }
        startCroquetNetwork()
        .then(session => {
            this.croquetNetwork = session;
            func(this.croquetNetwork.view);
            continueExecution();
        }).catch(error => {
            console.error("Failed to join Croquet session", error);
            continueExecution();
        });
      });
    },

  };
}


const CROQUET_URL = "https://cdn.jsdelivr.net/npm/@croquet/croquet@1.1.0-41";

let croquetPromise;
let sessionPromise;

async function startCroquetNetwork() {
    // load Croquet only once (and only if we need it)
    if (!croquetPromise) croquetPromise = new Promise(resolve => {
        if (window.Croquet) resolve(); // already loaded
        else {
            const script = document.createElement("script");
            script.src = CROQUET_URL;
            document.head.appendChild(script);
            script.onload = resolve;
        }
    });

    await croquetPromise; // wait for Croquet to load

    // the shared network, syncronized by Croquet
    class NetworkModel extends Croquet.Model {
      init(options) {
          super.init(options);
          this.ipTable = [null]; // index 0 is unused
          this.hosts = new Map();
          this.ipAddresses = new Map();
          this.connections = new Map();
          this.broadcasts = new Map(); // port => number of hosts listening
          this.subscribe(this.sessionId, "view-join", this.hostJoined);
          this.subscribe(this.sessionId, "view-exit", this.hostExited);
      }

      hostJoined(hostName) {
          // allocate an IP address for the new participant
          let i = 1;
          while (this.ipTable[i]) i++;
          if (i > 0xFFFF) throw new Error("Too many participants"); // unlikely
          // we use 10.42.*.* for the IP addresses
          let ipAddress = [10, 42, i >> 8, i & 0xFF].join(".");
          let host = {
              ipIndex: i,
              ipAddress,
              tcpPorts: new Set(),
              udpPorts: new Set(),
          }
          this.ipTable[i] = host;
          this.ipAddresses.set(ipAddress, host);
          this.hosts.set(hostName, host);
          this.publish(this.id, "ip-allocated", {hostName, ipAddress});
          this.subscribe(ipAddress, "listen", this.listen);
      }

      hostExited(hostName) {
          const host = this.hosts.get(hostName);
          this.ipTable[host.ipIndex] = null;
          this.ipAddresses.delete(host.ipAddress);
          this.hosts.delete(hostName);
          this.unsubscribe(host.ipAddress, "listen", "*");
          for (let port of host.tcpPorts) {
              const ipAndPort = host.ipAddress + ":" + port;
              this.unsubscribe(ipAndPort, "tcp-connect", "*");
              this.publish(ipAndPort, "tcp-disconnected");
          }
          for (let port of host.udpPorts) {
            const ipAndPort = host.ipAddress + ":" + port;
            this.unsubscribe(ipAndPort, "udp-send", "*");
            let count = this.broadcasts.get(port);
            this.broadcasts.set(port, --count);
            if (count === 0) {
              const broadcastAddrAndPort = "255.255.255.255:" + port;
              this.unsubscribe(broadcastAddrAndPort, "udp-send", "*");
            }

        }
        this.publish(this.id, "ip-released", {hostName, ipAddress: host.ipAddress});
      }

      listen({ip, port, tcp}) {
          // a participant wants to listen on a port
          const host = this.ipAddresses.get(ip);
          if (!host) return;
          let ports = tcp ? host.tcpPorts : host.udpPorts;
          if (ports.has(port)) return; // already listening
          ports.add(port);
          const ipAndPort = host.ipAddress + ":" + port;
          if (tcp) this.subscribe(ipAndPort, "tcp-connect", this.tcpConnect);
          else {
            this.subscribe(ipAndPort, "udp-send", this.udpSend);
            let count = this.broadcasts.get(port) || 0;
            this.broadcasts.set(port, ++count);
            if (count === 1) {
              const broadcastAddrAndPort = "255.255.255.255:" + port;
              this.subscribe(broadcastAddrAndPort, "udp-send", this.udpBroadcast);
            }
          }
          this.publish(ipAndPort, "listening");
      }

      tcpConnect({src, dst, port}) {
        let ipAndPort = dst + ":" + port;
        console.log("@" + this.now() + " TCP connect " + src + " to " + ipAndPort);
      }

      udpSend({dst, port, data}) {
        let ipAndPort = dst + ":" + port;
        console.log("@" + this.now() + " UDP send " + data.length + " bytes to " + ipAndPort);
      }

      udpBroadcast({dst, port, data}) {
        let ipAndPort = dst + ":" + port;
        console.log("@" + this.now() + " UDP broadcast " + data.length + " bytes to " + ipAndPort);
      }

      closeConnection({from, to, port}) {
          // remove a connection between two participants
          const connectionId = from + "=>" + to + ":" + port;
          this.connections.delete(connectionId);
          this.publish("closed-connection", connectionId);
      }
    }
    NetworkModel.register("NetworkModel");

    // the local network participant
    class NetworkParticipantView extends Croquet.View {
        constructor(model) {
            super(model);
            this.model = model;
            this.subscribe(model.id, "ip-allocated", this.ipAllocated);
            this.subscribe(model.id, "ip-released", this.ipReleased);
            console.log("Croquet network: local participant " + this.viewId + " got IP " + this.ipAddress);
            console.log("Croquet network: " + this.model.hosts.size + " participant" + (this.model.hosts.size === 1 ? "" : "s"));
        }

        ipAllocated({hostName, ipAddress}) {
            console.log("Croquet network: allocated IP " + ipAddress + " to participant " + hostName);
        }

        ipReleased({hostName, ipAddress}) {
            console.log("Croquet network: released IP " + ipAddress + " from participant " + hostName);
        }

        get ipAddress() {
          const host = this.model.hosts.get(this.viewId);
          return host.ipAddress;
        }
    }

    // start session
    if (!sessionPromise) {
        let apiKey = window.location.search.match(/apiKey=([^&]+)/);
        if (apiKey) apiKey = apiKey[1];
        else apiKey = "1bfHo0sk3HLmzqxiaasuEFBccxNDE660vMzghymFm";
        sessionPromise = Croquet.Session.join({
            apiKey, // get your own from https://croquet.io/keys
            appId: "net.codefrau.jasmine", // can be anything
            model: NetworkModel,
            view: NetworkParticipantView,
            name: "Jasmine",
            password: "Jasmine",
            tps: 0, // if there are no future messages we don't need ticks
        });
    }

    return sessionPromise;
}

function registerSocketPlugin() {
    if (typeof Squeak === "object" && Squeak.registerExternalModule) {
        Squeak.registerExternalModule('SocketPlugin', SocketPlugin());
    } else self.setTimeout(registerSocketPlugin, 100);
};

registerSocketPlugin();
