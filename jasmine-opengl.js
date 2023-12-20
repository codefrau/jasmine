// This is an OpenGL implementation for SqueakJS using WebGL.

// It is very much incomplete and currently only implements
// the subset of OpenGL that is used by Croquet Jasmine,
// but could be extended to support more.

// The functions are invoked via FFI, which takes care of
// converting the arguments and return values between JS
// and Smalltalk.

// The OpenGL context is global and created by B3DAcceleratorPlugin.
// We currently do not support multiple contexts.

// helpful constant lookup:
// https://javagl.github.io/GLConstantsTranslator/GLConstantsTranslator.html

// TODO
// [ ] implement draw arrays
// [ ] implement material + lighting
// [ ] make glBitmap pixel-perfect
// [ ] optimize list compilation glBegin/glEnd
// [ ] emulate glLineWidth (WebGL usually only supports 1px lines)
//     e.g. using https://wwwtyro.net/2019/11/18/instanced-lines.html

// OpenGL constants (many missing in WebGL)
var GL;
var GL_Symbols; // reverse mapping for debug printing
initGLConstants();

function OpenGL() {
    "use strict";

    var DEBUG = 0; // 0 = off, 1 = some, 2 = lots

    var identity = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);

    // Primitive attributes for glBegin/glEnd
    var HAS_NORMAL     = 1 << 0;
    var HAS_COLOR      = 1 << 1;
    var HAS_TEXCOORD   = 1 << 2;

    // more flags for selecting shader
    var HAS_TEXTURE    = 1 << 3;
    var HAS_LIGHTING   = 1 << 4;
    var HAS_ALPHA_TEST = 1 << 5;
    var HAS_POINT_SIZE = 1 << 6;

    var gl;    // the emulated OpenGL state
    var webgl; // the actual WebGL context

    return {
        setInterpreter: function(anInterpreterProxy) {
            this.vm = anInterpreterProxy.vm;
            return true;
        },

        ffiFunctionNotFoundHandler: function(name, args) {
            this.vm.warnOnce("OpenGL: UNIMPLEMENTED (missing) " + name);
            if (DEBUG) debugger;
            return null; // do not fail but return nil
        },

        initialiseModule: function() {
            DEBUG > 1 && console.log("OpenGL: initialiseModule");
            // connect to B3DAcceleratorPlugin to get WebGL context
            var modules = SqueakJS.vm.primHandler.loadedModules;
            var B3DAcceleratorPlugin = modules['B3DAcceleratorPlugin'];
            if (!B3DAcceleratorPlugin) throw Error("OpenGL: B3DAcceleratorPlugin not loaded");
            this.GL = GL; // export constants
            this.GL_Symbol = GL_Symbol;
            B3DAcceleratorPlugin.setOpenGL(this); // will call makeCurrent()
        },

        makeCurrent: function(renderer) {
            if (webgl === renderer.webgl) return; // already current
            DEBUG > 1 && console.log("OpenGL: makeCurrent", renderer);
            webgl = renderer.webgl;
            gl = renderer.opengl;
            if (!gl) renderer.opengl = this.initGL();
        },

        initGL: function() {
            DEBUG > 1 && console.log("OpenGL: got context from B3DAcceleratorPlugin", webgl);
            // if webgl-lint is loaded, configure it
            const ext = webgl.getExtension('GMAN_debug_helper');
            if (ext) ext.setConfiguration({
                throwOnError: false,
            });
            // if Spector script is loaded, capture WebGL calls
            if (typeof SPECTOR !== "undefined") {
                var spector = new SPECTOR.Spector();
                spector.captureContext(webgl);
                spector.displayUI();
            }
            // initialize emulated OpenGL state
            gl = {
                alphaTest: false,
                alphaFunc: null,
                alphaRef: 0,
                extensions: "ARB_texture_non_power_of_two SGIS_generate_mipmap",
                color: new Float32Array(4),
                normal: new Float32Array([0, 0, 1]),
                texCoord: new Float32Array(2),
                primitive: null, // for glBegin/glEnd
                primitiveAttrs: 0, // for glVertex
                shaders: {}, // shader programs by attr/flags
                matrixMode: 0, // current matrix mode
                matrices: {}, // matrix stacks by mode
                matrix: null, // current matrix (matrices[mode][0])
                lighting: false,
                lights: [], // light states
                material: null, // material state
                textureIdGen: 0, // texture id generator
                textures: {}, // webgl texture objects by id
                texture: null, // texture
                textureEnabled: false, // texture enabled
                listIdGen: 0, // display list id generator
                lists: {}, // display lists by id
                list: null, // current display list
                listMode: 0, // current display list mode
                listBase: 0, // base for glCallLists
                pixelStoreUnpackRowLength: 0,
                pixelStoreUnpackSkipRows: 0,
                pixelStoreUnpackSkipPixels: 0,
                rasterPos: new Float32Array(4),
                rasterColor: new Float32Array([1, 1, 1, 1]),
                bitmapTexture: null, // texture for glBitmap
                bitmapVertexBuffer: null, // vertex buffer for glBitmap
                bitmapShader: { // shader program for glBitmap
                    program: null,
                    locations: {},
                }, // shader for glBitmap
                viewport: new Int32Array([0, 0, 0, 0]),
                depthRange: new Float32Array([0, 1]),
            };

            // set initial state
            gl.matrices[GL.MODELVIEW] = [new Float32Array(identity)];
            gl.matrices[GL.PROJECTION] = [new Float32Array(identity)];
            gl.matrixMode = GL.MODELVIEW;
            gl.matrix = gl.matrices[gl.matrixMode][0];
            gl.color.set([1, 1, 1, 1]);
            for (var i = 0; i < 8; i++) {
                gl.lights[i] = {
                    index: i,
                    enabled: false,
                    ambient: new Float32Array([0, 0, 0, 1]),
                    diffuse: new Float32Array([0, 0, 0, 1]),
                    specular: new Float32Array([0, 0, 0, 1]),
                    position: new Float32Array([0, 0, 1, 0]),
                    spotCutoff: 180,
                };
            }
            gl.material = {
                ambient: new Float32Array([0.2, 0.2, 0.2, 1]),
                diffuse: new Float32Array([0.8, 0.8, 0.8, 1]),
                specular: new Float32Array([0, 0, 0, 1]),
                emission: new Float32Array([0, 0, 0, 1]),
                shininess: 0,
            };
            return gl;
        },

        destroyGL: function(renderer) {
            DEBUG > 0 && console.log("OpenGL: destroyGL");
            // TODO: delete textures, arrays, shaders?
            renderer.opengl = null;
            webgl = null;
            gl = null;
        },

        // FFI functions get JS args, return JS result

        addToList: function(name, args) {
            if (!gl.list) return false;
            gl.list.commands.push({name: name, args: args});
            if (gl.listMode === GL.COMPILE) {
                DEBUG > 0 && console.log("[COMPILE]", name, args);
                return true;
            }
            return false;
        },

        glAlphaFunc: function(func, ref) {
            if (gl.listMode && this.addToList("glAlphaFunc", [func, ref])) return;
            DEBUG > 0 && console.log("glAlphaFunc", GL_Symbols[func], ref);
            gl.alphaFunc = func;
            gl.alphaRef = ref;
        },

        glBegin: function(mode) {
            if (gl.listMode && this.addToList("glBegin", [mode])) return;
            DEBUG > 1 && console.log("glBegin", GL_Symbols[mode]);
            gl.primitive = {
                mode: mode,
                vertices: [],
                vertexSize: 0,
                vertexAttrs: 0,
            }
            gl.primitiveAttrs = 0;
        },

        glBindTexture: function(target, texture) {
            if (gl.listMode && this.addToList("glBindTexture", [target, texture])) return;
            DEBUG > 1 && console.log("glBindTexture", GL_Symbols[target], texture);
            var textureObj = gl.textures[texture];
            if (!textureObj) throw Error("OpenGL: texture not found");
            webgl.bindTexture(target, textureObj);
            gl.texture = textureObj;
        },

        glBitmap: function(width, height, xorig, yorig, xmove, ymove, bitmap) {
            // bitmap is supposed to be declared as "GLubyte*" per OpenGL spec,
            // which the FFI would convert to Uint8Array for us. However, the
            // image FFI declaration uses "void*", probably because it makes no
            // difference in C, a pointer is a pointer. In JS, we get an
            // ArrayBuffer for "void*" so we need to convert it to Uint8Array
            // ourselves.
            if (!bitmap.buffer) bitmap = new Uint8Array(bitmap);
            if (gl.listMode && this.addToList("glBitmap", [width, height, xorig, yorig, xmove, ymove, bitmap])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glBitmap", width, height, xorig, yorig, xmove, ymove, bitmap);
            if (width > 0 && height > 0) {
                // we need to convert the 1-bit deep bitmap to a 1-byte
                // per pixel texture in ALPHA format, with the bitmap
                // mapping 0-bits to transparent, 1-bits to opaque,
                // and then draw it as a textured quad covering the viewport
                var texels = new Uint8Array(width * height);
                var bytesPerRow = Math.ceil(width / 32) * 4;
                for (var y = 0; y < height; y++) {
                    var byteIndex = y * bytesPerRow;
                    var bitIndex = 7;
                    for (var x = 0; x < width; x++) {
                        var bit = bitmap[byteIndex] & (1 << bitIndex);
                        if (bit) texels[y * width + x] = 255;
                        bitIndex--;
                        if (bitIndex < 0) {
                            byteIndex++;
                            bitIndex = 7;
                        }
                    }
                }
                // debug: print bitmap
                // s=''; for (y = height -1 ; y >= 0; y--) { for (x = 0; x < width; x++) s += texels[y * width + x] ? '⬛️' : '⬜️'; s+='\n'}; console.log(s)
                var texture = gl.bitmapTexture;
                if (!texture) {
                    texture = gl.bitmapTexture = webgl.createTexture();
                    webgl.bindTexture(webgl.TEXTURE_2D, texture);
                    webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_MIN_FILTER, webgl.LINEAR);
                    webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_MAG_FILTER, webgl.LINEAR);
                    webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_WRAP_S, webgl.CLAMP_TO_EDGE);
                    webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_WRAP_T, webgl.CLAMP_TO_EDGE);
                } else {
                    webgl.bindTexture(webgl.TEXTURE_2D, texture);
                }
                webgl.pixelStorei(webgl.UNPACK_ALIGNMENT, 1);
                webgl.texImage2D(webgl.TEXTURE_2D, 0, webgl.ALPHA, width, height, 0, webgl.ALPHA, webgl.UNSIGNED_BYTE, texels);
                webgl.pixelStorei(webgl.UNPACK_ALIGNMENT, 4);

                webgl.disable(webgl.CULL_FACE);
                webgl.disable(webgl.DEPTH_TEST);
                webgl.disable(webgl.BLEND);
                webgl.colorMask(true, true, true, true);
                webgl.viewport(0, 0, webgl.drawingBufferWidth, webgl.drawingBufferHeight);
                var vertexBuffer = gl.bitmapVertexBuffer;
                if (!vertexBuffer) {
                    var vertices = new Float32Array([
                        0, 0,
                        1, 0,
                        0, 1,
                        1, 1,
                    ]);
                    vertexBuffer = gl.bitmapVertexBuffer = webgl.createBuffer();
                    webgl.bindBuffer(webgl.ARRAY_BUFFER, vertexBuffer);
                    webgl.bufferData(webgl.ARRAY_BUFFER, vertices, webgl.STATIC_DRAW);
                } else {
                    webgl.bindBuffer(webgl.ARRAY_BUFFER, vertexBuffer);
                }
                var shader = gl.bitmapShader;
                if (!shader.program) {
                    shader.program = webgl.createProgram();
                    var vs = webgl.createShader(webgl.VERTEX_SHADER);
                    webgl.shaderSource(vs, `
                        attribute vec2 a_position;
                        uniform vec3 u_raster;
                        uniform vec2 u_rasterOffset;
                        uniform vec2 u_rasterScale;
                        uniform vec2 u_translate;
                        uniform vec2 u_scale;
                        varying vec2 v_texcoord;
                        void main() {
                            vec2 raster = u_raster.xy * u_rasterScale + u_rasterOffset;
                            vec2 pos = (a_position + raster) * u_scale + u_translate;
                            gl_Position = vec4(pos, u_raster.z, 1);
                            v_texcoord = a_position;
                        }
                    `);
                    webgl.compileShader(vs);
                    if (!webgl.getShaderParameter(vs, webgl.COMPILE_STATUS)) {
                        console.error("OpenGL: vertex shader compile error: " + webgl.getShaderInfoLog(vs));
                        debugger;
                        return;
                    }
                    var fs = webgl.createShader(webgl.FRAGMENT_SHADER);
                    webgl.shaderSource(fs, `
                        precision mediump float;
                        uniform sampler2D u_texture;
                        uniform vec4 u_color;
                        varying vec2 v_texcoord;
                        void main() {
                            float alpha = texture2D(u_texture, v_texcoord).a;
                            if (alpha < 0.5) discard;
                            gl_FragColor = u_color;
                        }
                    `);
                    webgl.compileShader(fs);
                    if (!webgl.getShaderParameter(fs, webgl.COMPILE_STATUS)) {
                        console.error("OpenGL: fragment shader compile error: " + webgl.getShaderInfoLog(fs));
                        debugger;
                        return;
                    }
                    webgl.attachShader(shader.program, vs);
                    webgl.attachShader(shader.program, fs);
                    webgl.linkProgram(shader.program);
                    if (!webgl.getProgramParameter(shader.program, webgl.LINK_STATUS)) {
                        console.error("OpenGL: shader link error: " + webgl.getProgramInfoLog(shader.program));
                        debugger
                        return;
                    }
                    shader.locations = {
                        a_position: webgl.getAttribLocation(shader.program, "a_position"),
                        u_texture: webgl.getUniformLocation(shader.program, "u_texture"),
                        u_color: webgl.getUniformLocation(shader.program, "u_color"),
                        u_raster: webgl.getUniformLocation(shader.program, "u_raster"),
                        u_rasterOffset: webgl.getUniformLocation(shader.program, "u_rasterOffset"),
                        u_rasterScale: webgl.getUniformLocation(shader.program, "u_rasterScale"),
                        u_translate: webgl.getUniformLocation(shader.program, "u_translate"),
                        u_scale: webgl.getUniformLocation(shader.program, "u_scale"),
                    };
                }
                webgl.useProgram(shader.program);
                webgl.enableVertexAttribArray(shader.locations.a_position);
                webgl.vertexAttribPointer(shader.locations.a_position, 2, webgl.FLOAT, false, 0, 0);
                webgl.uniform1i(shader.locations.u_texture, 0);
                webgl.uniform4fv(shader.locations.u_color, gl.rasterColor);
                // these seem to work for 640x480... I can't figure out the right transform yet
                if (!this.bitmapScale) this.bitmapScale = [0.0311, 0.0419];
                if (!this.bitmapTranslate) this.bitmapTranslate = [-1, -1];
                if (!this.bitmapRasterOffset) this.bitmapRasterOffset = [0, 0];
                if (!this.bitmapRasterScale) this.bitmapRasterScale = [0.1, 0.1];
                // these properties allow intereactive debugging
                webgl.uniform3f(shader.locations.u_raster, gl.rasterPos[0] + xorig, gl.rasterPos[1] + yorig, gl.rasterPos[2]);
                webgl.uniform2fv(shader.locations.u_rasterOffset, this.bitmapRasterOffset);
                webgl.uniform2fv(shader.locations.u_rasterScale, this.bitmapRasterScale);
                webgl.uniform2fv(shader.locations.u_translate, this.bitmapTranslate);
                webgl.uniform2fv(shader.locations.u_scale, this.bitmapScale);
                webgl.drawArrays(webgl.TRIANGLE_STRIP, 0, 4);
                webgl.disableVertexAttribArray(shader.locations.a_position);
                webgl.bindBuffer(webgl.ARRAY_BUFFER, null);
                webgl.useProgram(null);
                webgl.bindTexture(webgl.TEXTURE_2D, null);
                webgl.enable(webgl.CULL_FACE);
                webgl.enable(webgl.DEPTH_TEST);
                webgl.enable(webgl.BLEND);
            }
            gl.rasterPos[0] += xmove;
            gl.rasterPos[1] += ymove;
        },

        glBlendFunc: function(sfactor, dfactor) {
            if (gl.listMode && this.addToList("glBlendFunc", [sfactor, dfactor])) return;
            DEBUG > 1 && console.log("glBlendFunc", GL_Symbols[sfactor], GL_Symbols[dfactor]);
            webgl.blendFunc(sfactor, dfactor);
        },

        glCallList: function(list) {
            if (gl.listMode && this.addToList("glCallList", [list])) return;
            DEBUG > 1 && console.log("glCallList", list, "START");
            this.executeList(list);
            DEBUG > 1 && console.log("glCallList", list.id, "DONE");
        },

        glCallLists: function(n, type, lists) {
            if (gl.listMode && this.addToList("glCallLists", [n, type, lists])) return;
            DEBUG > 1 && console.log("glCallLists", n, GL_Symbols[type], lists);
            var array;
            switch (type) {
                case GL.BYTE:
                    array = new Int8Array(lists);
                    break;
                case GL.UNSIGNED_BYTE:
                    array = new Uint8Array(lists);
                    break;
                case GL.INT:
                    array = new Int32Array(lists);
                    break;
                case GL.UNSIGNED_INT:
                    array = new Uint32Array(lists);
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glCallLists type", GL_Symbols[type]);
                    return;
            }
            for (var i = 0; i < n; i++) {
                var list = gl.listBase + array[i];
                this.executeList(list);
            }
        },

        glClear: function(mask) {
            if (gl.listMode && this.addToList("glClear", [mask])) return;
            var maskString = "";
            if (mask & webgl.COLOR_BUFFER_BIT) maskString += " COLOR";
            if (mask & webgl.DEPTH_BUFFER_BIT) maskString += " DEPTH";
            if (mask & webgl.STENCIL_BUFFER_BIT) maskString += " STENCIL";
            DEBUG > 1 && console.log("glClear"+ maskString);
            webgl.clear(mask);
            // B3DAcceleratorPlugin will call vm.breakNow()
            // to emulate double buffering (which will return
            // control to the browser which will flush the canvas).
            // We discourage breaking until then to avoid flicker
            // glClear is a good place for that since it's usually
            // called at least once per frame
            this.vm.breakAfter(500);
        },

        glClearColor: function(red, green, blue, alpha) {
            if (gl.listMode && this.addToList("glClearColor", [red, green, blue, alpha])) return;
            DEBUG > 1 && console.log("glClearColor", red, green, blue, alpha);
            webgl.clearColor(red, green, blue, alpha);
        },

        glColor3f: function(red, green, blue) {
            if (gl.listMode && this.addToList("glColor3f", [red, green, blue])) return;
            DEBUG > 1 && console.log("glColor3f", red, green, blue);
            gl.color[0] = red;
            gl.color[1] = green;
            gl.color[2] = blue;
            gl.color[3] = 1;
            gl.primitiveAttrs |= HAS_COLOR;
        },

        glColor3fv: function(v) {
            if (gl.listMode && this.addToList("glColor3fv", [v])) return;
            DEBUG > 1 && console.log("glColor3fv", Array.from(v));
            gl.color.set(v);
            gl.color[3] = 1;
            gl.primitiveAttrs |= HAS_COLOR;
        },

        glColor4d: function(red, green, blue, alpha) {
            if (gl.listMode && this.addToList("glColor4d", [red, green, blue, alpha])) return;
            DEBUG > 1 && console.log("glColor4d", red, green, blue, alpha);
            gl.color[0] = red;
            gl.color[1] = green;
            gl.color[2] = blue;
            gl.color[3] = alpha;
            gl.primitiveAttrs |= HAS_COLOR;
        },

        glColor4f: function(red, green, blue, alpha) {
            if (gl.listMode && this.addToList("glColor4f", [red, green, blue, alpha])) return;
            DEBUG > 1 && console.log("glColor4f", red, green, blue, alpha);
            gl.color[0] = red;
            gl.color[1] = green;
            gl.color[2] = blue;
            gl.color[3] = alpha;
            gl.primitiveAttrs |= HAS_COLOR;
        },

        glColor4fv: function(v) {
            if (gl.listMode && this.addToList("glColor4fv", [v])) return;
            DEBUG > 1 && console.log("glColor4fv", Array.from(v));
            gl.color.set(v);
            gl.primitiveAttrs |= HAS_COLOR;
        },

        glColorMask: function(red, green, blue, alpha) {
            if (gl.listMode && this.addToList("glColorMask", [red, green, blue, alpha])) return;
            DEBUG > 1 && console.log("glColorMask", red, green, blue, alpha);
            webgl.colorMask(red, green, blue, alpha);
        },

        glClipPlane: function(plane, equation) {
            if (gl.listMode && this.addToList("glClipPlane", [plane, equation])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glClipPlane", GL_Symbols[plane], Array.from(equation));
        },

        glDeleteLists: function(list, range) {
            DEBUG > 0 && console.log("glDeleteLists", list, range);
            for (var i = 0; i < range; i++) {
                delete gl.lists[list + i];
            }
        },

        glDeleteTextures: function(n, textures) {
            DEBUG > 0 && console.log("glDeleteTextures", n, Array.from(textures));
            for (var i = 0; i < n; i++) {
                var id = textures[i];
                var texture = gl.textures[id];
                if (texture) {
                    webgl.deleteTexture(texture);
                    if (gl.texture === texture) gl.texture = null;
                }
                delete gl.textures[id];
            }
        },

        glDepthFunc: function(func) {
            if (gl.listMode && this.addToList("glDepthFunc", [func])) return;
            DEBUG > 0 && console.log("glDepthFunc", GL_Symbols[func]);
            webgl.depthFunc(func);
        },

        glDepthMask: function(flag) {
            if (gl.listMode && this.addToList("glDepthMask", [flag])) return;
            DEBUG > 1 && console.log("glDepthMask", flag);
            webgl.depthMask(flag);
        },

        glDepthRange: function(zNear, zFar) {
            if (gl.listMode && this.addToList("glDepthRange", [zNear, zFar])) return;
            DEBUG > 1 && console.log("glDepthRange", zNear, zFar);
            webgl.depthRange(zNear, zFar);
        },

        glDisable: function(cap) {
            if (gl.listMode && this.addToList("glDisable", [cap])) return;
            switch (cap) {
                case GL.ALPHA_TEST:
                    DEBUG > 1 && console.log("glDisable GL_ALPHA_TEST");
                    gl.alphaTest = false;
                    break;
                case webgl.BLEND:
                    DEBUG > 1 && console.log("glDisable GL_BLEND");
                    webgl.disable(webgl.BLEND);
                    break;
                case webgl.CULL_FACE:
                    DEBUG > 1 && console.log("glDisable GL.CULL_FACE");
                    webgl.disable(webgl.CULL_FACE);
                    break;
                case webgl.DEPTH_TEST:
                    DEBUG > 1 && console.log("glDisable GL_DEPTH_TEST");
                    webgl.disable(webgl.DEPTH_TEST);
                    break;
                case GL.LIGHT0:
                case GL.LIGHT1:
                case GL.LIGHT2:
                case GL.LIGHT3:
                case GL.LIGHT4:
                case GL.LIGHT5:
                case GL.LIGHT6:
                case GL.LIGHT7:
                    DEBUG > 1 && console.log("glDisable GL_LIGHT" + (cap - GL.LIGHT0));
                    gl.lights[cap - GL.LIGHT0].enabled = false;
                    break;
                case GL.LIGHTING:
                    DEBUG > 1 && console.log("glDisable GL_LIGHTING");
                    gl.lighting = false;
                    break;
                case webgl.POLYGON_OFFSET_FILL:
                    DEBUG > 1 && console.log("glDisable GL_POLYGON_OFFSET_FILL");
                    webgl.disable(webgl.POLYGON_OFFSET_FILL);
                    break;
                case webgl.STENCIL_TEST:
                    DEBUG > 1 && console.log("glDisable GL_STENCIL_TEST");
                    webgl.disable(webgl.STENCIL_TEST);
                    break;
                case webgl.TEXTURE_2D:
                    DEBUG > 1 && console.log("glDisable GL_TEXTURE_2D");
                    gl.textureEnabled = false;
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glDisable", GL_Symbols[cap] || cap);
            }
        },

        glDisableClientState: function(cap) {
            if (gl.listMode && this.addToList("glDisableClientState", [cap])) return;
            switch (cap) {
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glDisableClientState", GL_Symbols[cap] || cap);
            }
        },

        glDrawElements: function(mode, count, type, indices) {
            if (gl.listMode && this.addToList("glDrawElements", [mode, count, type, indices])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glDrawElements", GL_Symbols[mode], count, GL_Symbols[type], indices);
        },

        glEnable: function(cap) {
            if (gl.listMode && this.addToList("glEnable", [cap])) return;
            switch (cap) {
                case GL.ALPHA_TEST:
                    DEBUG > 1 && console.log("glEnable GL_ALPHA_TEST");
                    gl.alphaTest = true;
                    break;
                case webgl.BLEND:
                    DEBUG > 1 && console.log("glEnable GL_BLEND");
                    webgl.enable(webgl.BLEND);
                    break;
                case webgl.CULL_FACE:
                    DEBUG > 1 && console.log("glEnable GL_CULL_FACE");
                    webgl.enable(webgl.CULL_FACE);
                    break;
                case webgl.DEPTH_TEST:
                    DEBUG > 1 && console.log("glEnable GL_DEPTH_TEST");
                    webgl.enable(webgl.DEPTH_TEST);
                    break;
                case GL.LIGHT0:
                case GL.LIGHT1:
                case GL.LIGHT2:
                case GL.LIGHT3:
                case GL.LIGHT4:
                case GL.LIGHT5:
                case GL.LIGHT6:
                case GL.LIGHT7:
                    DEBUG > 1 && console.log("glEnable GL_LIGHT" + (cap - GL.LIGHT0));
                    gl.lights[cap - GL.LIGHT0].enabled = true;
                    break;
                case GL.LIGHTING:
                    DEBUG > 1 && console.log("glEnable GL_LIGHTING");
                    gl.lighting = true;
                    break;
                case webgl.POLYGON_OFFSET_FILL:
                    DEBUG > 1 && console.log("glEnable GL_POLYGON_OFFSET_FILL");
                    webgl.enable(webgl.POLYGON_OFFSET_FILL);
                    break;
                case webgl.STENCIL_TEST:
                    DEBUG > 1 && console.log("glEnable GL_STENCIL_TEST");
                    webgl.enable(webgl.STENCIL_TEST);
                    break;
                case webgl.TEXTURE_2D:
                    DEBUG > 1 && console.log("glEnable GL_TEXTURE_2D");
                    gl.textureEnabled = true;
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glEnable", GL_Symbols[cap] || cap);
            }
        },

        glEnableClientState: function(cap) {
            if (gl.listMode && this.addToList("glEnableClientState", [cap])) return;
            switch (cap) {
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glEnableClientState", GL_Symbols[cap] || cap);
            }
        },

        glEnd: function() {
            if (gl.listMode && this.addToList("glEnd", [])) return;
            var primitive = gl.primitive;
            gl.primitive = null;

            // select shader
            var shaderFlags = primitive.vertexAttrs;
            if (gl.textureEnabled && gl.texture) shaderFlags |= HAS_TEXTURE;
            if (gl.lighting) shaderFlags |= HAS_LIGHTING;
            if (gl.alphaTest) shaderFlags |= HAS_ALPHA_TEST;
            if (primitive.mode === webgl.POINTS) shaderFlags |= HAS_POINT_SIZE;

            // debug output
            var flagString = "";
            if (shaderFlags & HAS_NORMAL) flagString += " NORMAL";
            if (shaderFlags & HAS_COLOR) flagString += " COLOR";
            if (shaderFlags & HAS_TEXCOORD) flagString += " TEXCOORD";
            if (shaderFlags & HAS_TEXTURE) flagString += " TEXTURE";
            if (shaderFlags & HAS_LIGHTING) flagString += " LIGHTING";
            if (shaderFlags & HAS_ALPHA_TEST) flagString += " ALPHA_TEST";
            if (shaderFlags & HAS_POINT_SIZE) flagString += " POINT_SIZE";

            if (!!(shaderFlags & HAS_TEXTURE) !== !!(shaderFlags & HAS_TEXCOORD)) {
                shaderFlags &= ~(HAS_TEXTURE + HAS_TEXCOORD);
                flagString += " (disabling texture)";
            }

            if (shaderFlags & HAS_LIGHTING) {
                shaderFlags &= ~(HAS_LIGHTING + HAS_NORMAL);
                flagString += " (UNIMPLEMENTED lighting)";
            }

            if (shaderFlags & (~(HAS_TEXCOORD + HAS_TEXTURE + HAS_NORMAL + HAS_COLOR + HAS_POINT_SIZE))) {
                DEBUG > 0 && console.log("UNIMPLEMENTED glEnd " + GL_Symbols[primitive.mode] + ":" + flagString);
                return;
            }

            // create shader program
            var shader = gl.shaders[shaderFlags];
            if (!shader) {
                shader = gl.shaders[shaderFlags] = {
                    program: webgl.createProgram(),
                    locations: null,
                };
                var vs = webgl.createShader(webgl.VERTEX_SHADER);
                webgl.shaderSource(vs, this.vertexShaderSource(shaderFlags));
                webgl.compileShader(vs);
                if (!webgl.getShaderParameter(vs, webgl.COMPILE_STATUS)) {
                    console.error("OpenGL: vertex shader compile error: " + webgl.getShaderInfoLog(vs));
                    debugger;
                    return;
                }
                var fs = webgl.createShader(webgl.FRAGMENT_SHADER);
                webgl.shaderSource(fs, this.fragmentShaderSource(shaderFlags));
                webgl.compileShader(fs);
                if (!webgl.getShaderParameter(fs, webgl.COMPILE_STATUS)) {
                    console.error("OpenGL: fragment shader compile error: " + webgl.getShaderInfoLog(fs));
                    debugger;
                    return;
                }
                webgl.attachShader(shader.program, vs);
                webgl.attachShader(shader.program, fs);
                webgl.linkProgram(shader.program);
                if (!webgl.getProgramParameter(shader.program, webgl.LINK_STATUS)) {
                    console.error("OpenGL: shader link error: " + webgl.getProgramInfoLog(shader.program));
                    debugger
                    return;
                }
                shader.locations = this.getLocations(shader.program, shaderFlags);
            }
            webgl.useProgram(shader.program);

            // create interleaved vertex buffer
            var vertices = primitive.vertices;
            var size = primitive.vertexSize;
            var data = new Float32Array(vertices.length * size);
            for (var i = 0, offset = 0; i < vertices.length; i++, offset += size) {
                data.set(vertices[i], offset);
            }
            var vertexBuffer = webgl.createBuffer();
            webgl.bindBuffer(webgl.ARRAY_BUFFER, vertexBuffer);
            webgl.bufferData(webgl.ARRAY_BUFFER, data, webgl.DYNAMIC_DRAW);

            // set drawMode depending on primitive mode
            // and create index buffer if needed
            var drawMode;
            var indices;

            switch (primitive.mode) {
                // supported by WebGL, no index buffer needed
                case webgl.POINTS:
                case webgl.LINES:
                case webgl.LINE_LOOP:
                case webgl.LINE_STRIP:
                case webgl.TRIANGLES:
                case webgl.TRIANGLE_STRIP:
                case webgl.TRIANGLE_FAN:
                    DEBUG > 1 && console.log("glEnd " + GL_Symbols[primitive.mode] + ":" + flagString);
                    drawMode = primitive.mode;
                    break;
                // not supported by WebGL, emulate
                case GL.QUADS:
                    // use triangles and an index buffer to
                    // duplicate vertices as v0-v1-v2, v2-v1-v3
                    // we assume that all attributes are floats
                    DEBUG > 1 && console.log("glEnd GL_QUADS:" + flagString);
                    indices = vertices.length > 256
                        ? new Uint16Array(vertices.length * 3 / 2)
                        : new Uint8Array(vertices.length * 3 / 2);
                    var offset = 0;
                    for (var i = 0; i < vertices.length; i += 4) {
                        indices[offset++] = i;
                        indices[offset++] = i+1;
                        indices[offset++] = i+2;
                        indices[offset++] = i;
                        indices[offset++] = i+2;
                        indices[offset++] = i+3;
                    }
                    drawMode = webgl.TRIANGLES;
                    break;
                case GL.QUAD_STRIP:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glEnd GL_QUAD_STRIP:" + flagString);
                    return;
                case GL.POLYGON:
                    // use triangle fan, which works for convex polygons
                    DEBUG > 1 && console.log("glEnd GL_POLYGON:" + flagString);
                    drawMode = webgl.TRIANGLE_FAN;
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glEnd", primitive.mode, flagString);
                    return;
            }
            var indexBuffer;
            if (indices) {
                indexBuffer = webgl.createBuffer();
                webgl.bindBuffer(webgl.ELEMENT_ARRAY_BUFFER, indexBuffer);
                webgl.bufferData(webgl.ELEMENT_ARRAY_BUFFER, indices, webgl.DYNAMIC_DRAW);
            }

            // set up uniforms and vertex attributes
            var stride = size * 4;
            var offset = 0;
            var loc = gl.shaders[shaderFlags].locations;
            DEBUG > 1 && console.log("uModelView", Array.from(gl.matrices[GL.MODELVIEW][0]));
            webgl.uniformMatrix4fv(loc['uModelView'], false, gl.matrices[GL.MODELVIEW][0]);
            DEBUG > 1 && console.log("uProjection", Array.from(gl.matrices[GL.PROJECTION][0]));
            webgl.uniformMatrix4fv(loc['uProjection'], false, gl.matrices[GL.PROJECTION][0]);
            DEBUG > 1 && console.log("aPosition", size, stride, offset);
            webgl.vertexAttribPointer(loc['aPosition'], 3, webgl.FLOAT, false, stride, offset);
            webgl.enableVertexAttribArray(loc['aPosition']);
            offset += 12;
            if (loc['aNormal'] >= 0) {
                DEBUG > 1 && console.log("aNormal", size, stride, offset);
                webgl.vertexAttribPointer(loc['aNormal'], 3, webgl.FLOAT, false, stride, offset);
                webgl.enableVertexAttribArray(loc['aNormal']);
                offset += 12;
            } else if (loc['uNormal']) {
                DEBUG > 1 && console.log("uNormal", Array.from(gl.normal));
                webgl.uniform3fv(loc['uNormal'], gl.normal);
            }
            if (loc['aColor'] >= 0) {
                DEBUG > 1 && console.log("aColor", size, stride, offset);
                webgl.vertexAttribPointer(loc['aColor'], 4, webgl.FLOAT, false, stride, offset);
                webgl.enableVertexAttribArray(loc['aColor']);
                offset += 16;
            } else if (loc['uColor']) {
                DEBUG > 1 && console.log("uColor", Array.from(gl.color));
                webgl.uniform4fv(loc['uColor'], gl.color);
            }
            if (loc['aTexCoord'] >= 0) {
                DEBUG > 1 && console.log("aTexCoord", size, stride, offset);
                webgl.vertexAttribPointer(loc['aTexCoord'], 2, webgl.FLOAT, false, stride, offset);
                webgl.enableVertexAttribArray(loc['aTexCoord']);
                offset += 8;
            }
            if (loc['uSampler']) {
                DEBUG > 1 && console.log("uSampler", gl.texture);
                webgl.activeTexture(webgl.TEXTURE0);
                webgl.bindTexture(webgl.TEXTURE_2D, gl.texture);
                webgl.uniform1i(loc['uSampler'], 0);
            }
            if (loc['uPointSize']) {
                DEBUG > 1 && console.log("uPointSize", gl.pointSize);
                webgl.uniform1f(loc['uPointSize'], gl.pointSize);
            }

            // draw
            webgl.bindBuffer(webgl.ARRAY_BUFFER, vertexBuffer);
            if (indexBuffer) {
                webgl.bindBuffer(webgl.ELEMENT_ARRAY_BUFFER, indexBuffer);
                DEBUG > 1 && console.log("glDrawElements", GL_Symbols[drawMode], indices.length);
                webgl.drawElements(drawMode, indices.length, vertices.length > 256 ? webgl.UNSIGNED_SHORT : webgl.UNSIGNED_BYTE, 0);
            } else {
                DEBUG > 1 && console.log("glDrawArrays", GL_Symbols[drawMode], 0, vertices.length);
                webgl.drawArrays(drawMode, 0, vertices.length);
            }
        },

        glEndList: function() {
            DEBUG > 1 && console.log("glEndList");
            var list = gl.list;
            gl.list = null;
            gl.lists[list.id] = list;
            gl.listMode = 0;
        },

        glFinish: function() {
            DEBUG > 1 && console.log("glFinish");
            webgl.finish();
        },

        glFlush: function() {
            DEBUG > 1 && console.log("glFlush");
            webgl.flush();
        },

        glFrontFace: function(mode) {
            if (gl.listMode && this.addToList("glFrontFace", [mode])) return;
            DEBUG > 1 && console.log("glFrontFace", GL_Symbols[mode]);
            webgl.frontFace(mode);
        },

        glFrustum: function(left, right, bottom, top, zNear, zFar) {
            if (gl.listMode && this.addToList("glFrustum", [left, right, bottom, top, zNear, zFar])) return;
            DEBUG > 1 && console.log("glFrustum", left, right, bottom, top, zNear, zFar);
            var m = gl.matrix;
            m[0] = 2 * zNear / (right - left);
            m[1] = 0;
            m[2] = 0;
            m[3] = 0;

            m[4] = 0;
            m[5] = 2 * zNear / (top - bottom);
            m[6] = 0;
            m[7] = 0;

            m[8] = (right + left) / (right - left);
            m[9] = (top + bottom) / (top - bottom);
            m[10] = -(zFar + zNear) / (zFar - zNear);
            m[11] = -1;

            m[12] = 0;
            m[13] = 0;
            m[14] = -(2 * zFar * zNear) / (zFar - zNear);
            m[15] = 0;
        },

        glGenLists: function(range) {
            DEBUG > 1 && console.log("glGenLists", range);
            var firstId = 0;
            if (range > 0) {
                firstId = gl.listIdGen + 1;
                gl.listIdGen += range;
            }
            return firstId;
        },

        glGenTextures: function(n, textures) {
            for (var i = 0; i < n; i++) {
                var id = ++gl.textureIdGen;
                gl.textures[id] = webgl.createTexture();
                textures[i] = id;
            }
            DEBUG > 1 && console.log("glGenTextures", n, Array.from(textures));
        },

        glGetFloatv: function(pname, params) {
            switch (pname) {
                case GL.MODELVIEW_MATRIX:
                    DEBUG > 1 && console.log("glGetFloatv GL_MODELVIEW_MATRIX");
                    params.set(gl.matrices[GL.MODELVIEW][0]);
                    break;
                case GL.PROJECTION_MATRIX:
                    DEBUG > 1 && console.log("glGetFloatv GL_PROJECTION_MATRIX");
                    params.set(gl.matrices[GL.PROJECTION][0]);
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glGetFloatv", GL_Symbols[pname] || pname);
            }
        },

        glGetIntegerv(name, params) {
            switch (name) {
                case GL.LIST_INDEX:
                    DEBUG > 1 && console.log("glGetIntegerv GL_LIST_INDEX");
                    params[0] = gl.list ? gl.list.id : 0;
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glGetIntegerv", GL_Symbols[name] || name);
            }
        },

        glGetString: function(name) {
            switch (name) {
                case GL.EXTENSIONS:
                    DEBUG > 0 && console.log("glGetString GL_EXTENSIONS");
                    return gl.extensions;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glGetString", name);
            }
            return "";
        },

        glGetTexLevelParameteriv: function(target, level, pname, params) {
            switch (pname) {
                case GL.TEXTURE_COMPRESSED:
                    return false;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glGetTexLevelParameteriv", target, level, pname, params);
            }
        },

        glHint: function(target, mode) {
            if (gl.listMode && this.addToList("glHint", [target, mode])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glHint", GL_Symbols[target], GL_Symbols[mode]);
        },

        glIsEnabled: function(cap) {
            switch (cap) {
                case GL.LIGHTING:
                    DEBUG > 0 && console.log("glIsEnabled GL_LIGHTING");
                    return gl.lighting;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glIsEnabled", cap);
            }
            return false;
        },

        glIsTexture: function(texture) {
            DEBUG > 1 && console.log("glIsTexture", texture);
            return !!gl.textures[texture];
        },

        glLightf: function(light, pname, param) {
            if (gl.listMode && this.addToList("glLightf", [light, pname, param])) return;
            var i = light - GL.LIGHT0;
            switch (pname) {
                case GL.SPOT_CUTOFF:
                    DEBUG > 1 && console.log("glLightf", i, "GL_SPOT_CUTOFF", param);
                    gl.lights[i].spotCutoff = param;
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glLightf", i, pname, param);
            }
        },

        glLightfv: function(light, pname, param) {
            if (gl.listMode && this.addToList("glLightfv", [light, pname, param])) return;
            var i = light - GL.LIGHT0;
            switch (pname) {
                case GL.AMBIENT:
                    DEBUG > 1 && console.log("glLightfv", i, "GL_AMBIENT", Array.from(param));
                    gl.lights[i].ambient = param;
                    break;
                case GL.DIFFUSE:
                    DEBUG > 1 && console.log("glLightfv", i, "GL_DIFFUSE", Array.from(param));
                    gl.lights[i].diffuse = param;
                    break;
                case GL.SPECULAR:
                    DEBUG > 1 && console.log("glLightfv", i, "GL_SPECULAR", Array.from(param));
                    gl.lights[i].specular = param;
                    break;
                case GL.POSITION:
                    transformPoint(gl.matrices[GL.MODELVIEW][0], param, Array.from(gl.lights[i].position));
                    DEBUG > 1 && console.log("glLightfv", i, "GL_POSITION", param, "=>", Array.from(gl.lights[i].position));
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glLightfv", i, GL_Symbols[pname], Array.from(param));
            }
        },

        glLineWidth: function(width) {
            if (gl.listMode && this.addToList("glLineWidth", [width])) return;
            DEBUG > 1 && console.log("glLineWidth", width);
            webgl.lineWidth(width);
        },

        glListBase: function(base) {
            DEBUG > 1 && console.log("glListBase", base);
            gl.listBase = base;
        },

        glLoadIdentity: function() {
            if (gl.listMode && this.addToList("glLoadIdentity", [])) return;
            DEBUG > 1 && console.log("glLoadIdentity");
            gl.matrix.set(identity);
        },

        glLoadMatrixf: function(m) {
            if (gl.listMode && this.addToList("glLoadMatrixf", [m])) return;
            gl.matrix.set(m);
            DEBUG > 1 && console.log("glLoadMatrixf", GL_Symbols[gl.matrixMode], Array.from(m));
        },

        glMaterialfv: function(face, pname, param) {
            if (gl.listMode && this.addToList("glMaterialfv", [face, pname, param])) return;
            switch (pname) {
                case GL.AMBIENT:
                    DEBUG > 1 && console.log("glMaterialfv GL_AMBIENT", Array.from(param));
                    gl.material.ambient = param;
                    break;
                case GL.DIFFUSE:
                    DEBUG > 1 && console.log("glMaterialfv GL_DIFFUSE", Array.from(param));
                    gl.material.diffuse = param;
                    break;
                case GL.SPECULAR:
                    DEBUG > 1 && console.log("glMaterialfv GL_SPECULAR", Array.from(param));
                    gl.material.specular = param;
                    break;
                case GL.EMISSION:
                    DEBUG > 1 && console.log("glMaterialfv GL_EMISSION", Array.from(param));
                    gl.material.emission = param;
                    break;
                case GL.SHININESS:
                    DEBUG > 1 && console.log("glMaterialfv GL_SHININESS", Array.from(param));
                    gl.material.shininess = param[0];
                    break;
                case GL.AMBIENT_AND_DIFFUSE:
                    DEBUG > 1 && console.log("glMaterialfv GL_AMBIENT_AND_DIFFUSE", Array.from(param));
                    gl.material.ambient = param;
                    gl.material.diffuse = param;
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glMaterialfv", GL_Symbols[pname], Array.from(param));
            }
        },

        glMatrixMode: function(mode) {
            if (gl.listMode && this.addToList("glMatrixMode", [mode])) return;
            if (mode !== GL.MODELVIEW && mode !== GL.PROJECTION)
                DEBUG > 0 && console.warn("UNIMPLEMENTED glMatrixMode", GL_Symbols[mode]);
            else
                DEBUG > 1 && console.log("glMatrixMode", GL_Symbols[mode]);
            gl.matrixMode = mode;
            if (!gl.matrices[mode]) gl.matrices[mode] = [new Float32Array(identity)];
            gl.matrix = gl.matrices[mode][0];
        },

        glMultMatrixf: function(m) {
            if (gl.listMode && this.addToList("glMultMatrixf", [m])) return;
            multMatrix(gl.matrix, m);
            DEBUG > 1 && console.log("glMultMatrixf", GL_Symbols[gl.matrixMode], Array.from(m), "=>", Array.from(gl.matrix));
        },

        glNewList: function(list, mode) {
            DEBUG > 1 && console.log("glNewList", list, GL_Symbols[mode]);
            var newList = {
                id: list,
                commands: [],
            };
            gl.list = newList;
            gl.listMode = mode;
        },

        glNormal3f: function(nx, ny, nz) {
            if (gl.listMode && this.addToList("glNormal3f", [nx, ny, nz])) return;
            DEBUG > 1 && console.log("glNormal3f", nx, ny, nz);
            gl.normal[0] = nx;
            gl.normal[1] = ny;
            gl.normal[2] = nz;
            gl.primitiveAttrs |= HAS_NORMAL;
        },

        glNormal3fv: function(v) {
            if (gl.listMode && this.addToList("glNormal3fv", [v])) return;
            DEBUG > 1 && console.log("glNormal3fv", Array.from(v));
            gl.normal.set(v);
            gl.primitiveAttrs |= HAS_NORMAL;
        },

        glNormalPointer: function(type, stride, pointer) {
            if (gl.listMode && this.addToList("glNormalPointer", [type, stride, pointer])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glNormalPointer", GL_Symbols[type], stride, pointer);
        },

        glPixelStorei: function(pname, param) {
            switch (pname) {
                case webgl.UNPACK_ALIGNMENT:
                    DEBUG > 1 && console.log("glPixelStorei GL_UNPACK_ALIGNMENT", param);
                    //@webgl.pixelStorei(webgl.UNPACK_ALIGNMENT, param);
                    break;
                case GL.UNPACK_LSB_FIRST:
                    if (param !== 0) console.log("UNIMPLEMENTED glPixelStorei GL_UNPACK_LSB_FIRST", param);
                    break;
                case GL.UNPACK_ROW_LENGTH:
                    DEBUG > 1 && console.log("glPixelStorei GL_UNPACK_ROW_LENGTH", param);
                    gl.pixelStoreUnpackRowLength = param;
                    break;
                case GL.UNPACK_SKIP_ROWS:
                    DEBUG > 1 && console.log("glPixelStorei GL_UNPACK_SKIP_ROWS", param);
                    gl.pixelStoreUnpackSkipRows = param;
                    break;
                case GL.UNPACK_SKIP_PIXELS:
                    DEBUG > 1 && console.log("glPixelStorei GL_UNPACK_SKIP_PIXELS", param);
                    gl.pixelStoreUnpackSkipPixels = param;
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glPixelStorei", pname, param);
            }
        },

        glPolygonOffset: function(factor, units) {
            if (gl.listMode && this.addToList("glPolygonOffset", [factor, units])) return;
            DEBUG > 1 && console.log("glPolygonOffset", factor, units);
            webgl.polygonOffset(factor, units);
        },

        glPushAttrib: function(mask) {
            if (gl.listMode && this.addToList("glPushAttrib", [mask])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glPushAttrib", mask);
        },

        glPushMatrix: function() {
            if (gl.listMode && this.addToList("glPushMatrix", [])) return;
            gl.matrix = new Float32Array(gl.matrix);
            gl.matrices[gl.matrixMode].unshift(gl.matrix);
            DEBUG > 1 && console.log("glPushMatrix", GL_Symbols[gl.matrixMode], "=>", Array.from(gl.matrix));
        },

        glPointSize: function(size) {
            if (gl.listMode && this.addToList("glPointSize", [size])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glPointSize", size);
            gl.pointSize = size;
        },

        glPopAttrib: function() {
            if (gl.listMode && this.addToList("glPopAttrib", [])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glPopAttrib");
        },

        glPopMatrix: function() {
            if (gl.listMode && this.addToList("glPopMatrix", [])) return;
            if (gl.matrices[gl.matrixMode].length <= 1)
                return DEBUG > 0 && console.warn("OpenGL: matrix stack underflow");
            gl.matrices[gl.matrixMode].shift();
            gl.matrix = gl.matrices[gl.matrixMode][0];
            DEBUG > 1 && console.log("glPopMatrix", GL_Symbols[gl.matrixMode], "=>", Array.from(gl.matrix));
        },

        glRasterPos3f: function(x, y, z) {
            if (gl.listMode && this.addToList("glRasterPos3f", [x, y, z])) return;
            DEBUG > 0 && console.log("glRasterPos3f", x, y, z);
            gl.rasterPos[0] = x;
            gl.rasterPos[1] = y;
            gl.rasterPos[2] = z;
            gl.rasterPos[3] = 1;
            // transform point via modelview and projection matrices
            var m = gl.matrices[GL.PROJECTION][0];
            transformPoint(m, gl.rasterPos, gl.rasterPos);
            m = gl.matrices[GL.MODELVIEW][0];
            transformPoint(m, gl.rasterPos, gl.rasterPos);
            // transform to window coordinates
            gl.rasterPos[0] = (gl.rasterPos[0] * 0.5 + 0.5) * gl.viewport[2] + gl.viewport[0];
            gl.rasterPos[1] = (gl.rasterPos[1] * 0.5 + 0.5) * gl.viewport[3] + gl.viewport[1];
            gl.rasterPos[2] = (gl.rasterPos[2] * 0.5 + 0.5) * (gl.depthRange[1] - gl.depthRange[0]) + gl.depthRange[0];
            // remember raster color
            gl.rasterColor.set(gl.color);
        },

        glTranslated: function(x, y, z) {
            if (gl.listMode && this.addToList("glTranslated", [x, y, z])) return;
            translateMatrix(gl.matrix, x, y, z);
            DEBUG > 1 && console.log("glTranslated", GL_Symbols[gl.matrixMode], x, y, z, "=>", Array.from(gl.matrix));
        },

        glTranslatef: function(x, y, z) {
            if (gl.listMode && this.addToList("glTranslatef", [x, y, z])) return;
            translateMatrix(gl.matrix, x, y, z);
            DEBUG > 1 && console.log("glTranslatef", GL_Symbols[gl.matrixMode], x, y, z, "=>", Array.from(gl.matrix));
        },

        glRotatef: function(angle, x, y, z) {
            if (gl.listMode && this.addToList("glRotatef", [angle, x, y, z])) return;
            rotateMatrix(gl.matrix, angle, x, y, z);
            DEBUG > 1 && console.log("glRotatef", GL_Symbols[gl.matrixMode], angle, x, y, z, "=>", Array.from(gl.matrix));
        },

        glScaled: function(x, y, z) {
            if (gl.listMode && this.addToList("glScaled", [x, y, z])) return;
            var m = gl.matrix;
            m[0] *= x; m[1] *= x; m[2] *= x; m[3] *= x;
            m[4] *= y; m[5] *= y; m[6] *= y; m[7] *= y;
            m[8] *= z; m[9] *= z; m[10] *= z; m[11] *= z;
            DEBUG > 1 && console.log("glScaled", GL_Symbols[gl.matrixMode], x, y, z, "=>", Array.from(gl.matrix));
        },

        glShadeModel: function(mode) {
            if (gl.listMode && this.addToList("glShadeModel", [mode])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glShadeModel", GL_Symbols[mode]);
        },

        glStencilFunc: function(func, ref, mask) {
            if (gl.listMode && this.addToList("glStencilFunc", [func, ref, mask])) return;
            DEBUG > 1 && console.log("glStencilFunc", GL_Symbols[func], ref, '0x'+(mask>>>0).toString(16));
            webgl.stencilFunc(func, ref, mask);
        },

        glStencilOp: function(fail, zfail, zpass) {
            if (gl.listMode && this.addToList("glStencilOp", [fail, zfail, zpass])) return;
            DEBUG > 1 && console.log("glStencilOp", GL_Symbols[fail], GL_Symbols[zfail], GL_Symbols[zpass]);
            webgl.stencilOp(fail, zfail, zpass);
        },

        glTexEnvi: function(target, pname, param) {
            if (gl.listMode && this.addToList("glTexEnvi", [target, pname, param])) return;
            switch (pname) {
                case GL.TEXTURE_ENV_MODE:
                    switch (param) {
                        case GL.MODULATE:
                            // Modulate means multiply the texture color with the fragment color
                            // which is what our fragment shader does by default
                            DEBUG > 1 && console.log("glTexEnvi", GL_Symbols[target], "GL_TEXTURE_ENV_MODE", GL_Symbols[param]);
                            break;
                        default:
                            DEBUG > 0 && console.log("UNIMPLEMENTED glTexEnvi", GL_Symbols[target], "GL_TEXTURE_ENV_MODE", GL_Symbols[param] || param);
                            return
                    }
                    break;
                default:
                    DEBUG > 0 && console.log("UNIMPLEMENTED glTexEnvi", GL_Symbols[target] || target, GL_Symbols[pname] || pname, GL_Symbols[param] || param);
            }
        },

        glTexImage2D: function(target, level, internalformat, width, height, border, format, type, pixels) {
            if (gl.listMode && this.addToList("glTexImage2D", [target, level, internalformat, width, height, border, format, type, pixels])) return;
            DEBUG > 1 && console.log("glTexImage2D", GL_Symbols[target], level, GL_Symbols[internalformat], width, height, border, GL_Symbols[format], GL_Symbols[type], pixels);
            gl.texture.width = width;
            gl.texture.height = height;
            // WebGL does not support GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS
            if (gl.pixelStoreUnpackRowLength !== 0 && gl.pixelStoreUnpackRowLength !== gl.texture.width) {
                DEBUG > 0 && console.warn("UNIMPLEMENTED glTexImage2D GL_UNPACK_ROW_LENGTH " + gl.pixelStoreUnpackRowLength);
            }
            if (gl.pixelStoreUnpackSkipRows !== 0) {
                DEBUG > 0 && console.warn("UNIMPLEMENTED glTexImage2D GL_UNPACK_SKIP_ROWS " + gl.pixelStoreUnpackSkipRows);
            }
            if (gl.pixelStoreUnpackSkipPixels !== 0) {
                DEBUG > 0 && console.warn("UNIMPLEMENTED glTexImage2D GL_UNPACK_SKIP_PIXELS " + gl.pixelStoreUnpackSkipPixels);
            }
            // WebGL only supports GL_RGBA
            switch (format) {
                case webgl.RGBA:
                    DEBUG > 0 && console.warn("glTexImage2D GL_RGBA: need to not swizzle BGRA");
                    break;
                case GL.BGRA:
                    format = webgl.RGBA;
                    // todo: swap bytes in shader
                    break;
                default:
                    DEBUG > 0 && console.warn("UNIMPLEMENTED glTexImage2D format " + format);
                    return;
            }
            // pixels are coming in via FFI as void* (ArrayBuffer)
            // convert to appropriate typed array
            // in OpenGL, pixels can be null to allocate texture storage
            if (!pixels) pixels = new ArrayBuffer(width * height * 4);
            switch (type) {
                case webgl.UNSIGNED_BYTE:
                    pixels = new Uint8Array(pixels);
                    break;
                default:
                    DEBUG > 0 && console.warn("UNIMPLEMENTED glTexImage2D type " + type);
                    return;
            }
            webgl.texImage2D(target, level, internalformat, width, height, border, format, type, pixels);
        },

        glTexCoord2d: function(s, t) {
            if (gl.listMode && this.addToList("glTexCoord2d", [s, t])) return;
            DEBUG > 1 && console.log("glTexCoord2d", s, t);
            gl.texCoord[0] = s;
            gl.texCoord[1] = t;
            gl.primitiveAttrs |= HAS_TEXCOORD;
        },

        glTexCoord2f: function(s, t) {
            if (gl.listMode && this.addToList("glTexCoord2f", [s, t])) return;
            DEBUG > 1 && console.log("glTexCoord2f", s, t);
            gl.texCoord[0] = s;
            gl.texCoord[1] = t;
            gl.primitiveAttrs |= HAS_TEXCOORD;
        },

        glTexCoord2fv: function(v) {
            if (gl.listMode && this.addToList("glTexCoord2fv", [v])) return;
            DEBUG > 1 && console.log("glTexCoord2fv", Array.from(v));
            gl.texCoord.set(v);
            gl.primitiveAttrs |= HAS_TEXCOORD;
        },

        glTexCoordPointer: function(size, type, stride, pointer) {
            if (gl.listMode && this.addToList("glTexCoordPointer", [size, type, stride, pointer])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glTexCoordPointer", size, GL_Symbols[type], stride, pointer);
        },

        glTexParameteri: function(target, pname, param) {
            if (gl.listMode && this.addToList("glTexParameteri", [target, pname, param])) return;
            DEBUG > 1 && console.log("glTexParameteri", GL_Symbols[target], GL_Symbols[pname], GL_Symbols[param] || param);
            webgl.texParameteri(target, pname, param);
        },

        glTexSubImage2D: function(target, level, xoffset, yoffset, width, height, format, type, pixels) {
            if (gl.listMode && this.addToList("glTexSubImage2D", [target, level, xoffset, yoffset, width, height, format, type, pixels])) return;
            DEBUG > 1 && console.log("glTexSubImage2D", GL_Symbols[target], level, xoffset, yoffset, width, height, GL_Symbols[format], GL_Symbols[type], pixels);
            // WebGL does not support GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS
            // emulate GL_UNPACK_SKIP_ROWS
            var pixelsOffset = gl.pixelStoreUnpackSkipRows * gl.texture.width; // to be multiplied by pixel size below
            // assume GL_UNPACK_ROW_LENGTH is full width (which is the case when uploading part of a bitmap in Squeak)
            if (gl.pixelStoreUnpackRowLength !== 0 && gl.pixelStoreUnpackRowLength !== gl.texture.width) {
                DEBUG > 0 && console.warn("UNIMPLEMENTED glTexSubImage2D GL_UNPACK_ROW_LENGTH " + gl.pixelStoreUnpackRowLength);
            }
            // WebGL does not support GL_UNPACK_SKIP_PIXELS to allow different width
            if (width !== gl.texture.width) {
                // we could either
                // 1. call texSubImage2D for each row
                // 2. copy subimage pixels into a new buffer
                // 3. call texSubImage2D for the whole width so we don't need to skip pixels
                // we choose 3. for now
                width = gl.texture.width;
                xoffset = 0;
            }
            // WebGL only supports RGB not BGR
            switch (format) {
                case webgl.RGBA:
                    pixelsOffset *= 4;
                    break;
                case GL.BGRA:
                    pixelsOffset *= 4;
                    format = webgl.RGBA;
                    break;
                default:
                    DEBUG > 0 && console.warn("UNIMPLEMENTED glTexSubImage2D format " + format);
                    return;
            }
            // pixels are coming in via FFI as void* (ArrayBuffer)
            // convert to appropriate typed array
            switch (type) {
                case webgl.UNSIGNED_BYTE:
                    pixels = new Uint8Array(pixels, pixelsOffset);
                    break;
                default:
                    DEBUG > 0 && console.warn("UNIMPLEMENTED glTexSubImage2D type " + type);
                    return;
            }
            webgl.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels);
        },

        glVertex2f: function(x, y) {
            if (gl.listMode && this.addToList("glVertex2f", [x, y])) return;
            DEBUG > 1 && console.log("glVertex2f", x, y);
            var position = [x, y];
            this.pushVertex(position);
        },

        glVertex3f: function(x, y, z) {
            if (gl.listMode && this.addToList("glVertex3f", [x, y, z])) return;
            DEBUG > 1 && console.log("glVertex3f", x, y, z);
            var position = [x, y, z];
            this.pushVertex(position);
        },

        glVertex3fv: function(v) {
            if (gl.listMode && this.addToList("glVertex3fv", [v])) return;
            DEBUG > 1 && console.log("glVertex3fv", Array.from(v));
            this.pushVertex(v);
        },

        glVertex2i: function(x, y) {
            if (gl.listMode && this.addToList("glVertex2i", [x, y])) return;
            DEBUG > 1 && console.log("glVertex2i", x, y);
            var position = [x, y];
            this.pushVertex(position);
        },

        glVertexPointer: function(size, type, stride, pointer) {
            if (gl.listMode && this.addToList("glVertexPointer", [size, type, stride, pointer])) return;
            DEBUG > 0 && console.log("UNIMPLEMENTED glVertexPointer", size, GL_Symbols[type], stride, pointer);
        },

        glViewport: function(x, y, width, height) {
            if (gl.listMode && this.addToList("glViewport", [x, y, width, height])) return;
            DEBUG > 1 && console.log("glViewport", x, y, width, height);
            webgl.viewport(x, y, width, height);
            gl.viewport[0] = x;
            gl.viewport[1] = y;
            gl.viewport[2] = width;
            gl.viewport[3] = height;
        },

        pushVertex: function(position) {
            var primitive = gl.primitive;
            if (!primitive) throw Error("OpenGL: glBegin not called");
            if (!primitive.vertexSize) {
                var vertexSize = 3;
                if (gl.primitiveAttrs & HAS_NORMAL) vertexSize += 3;
                if (gl.primitiveAttrs & HAS_COLOR) vertexSize += 4;
                if (gl.primitiveAttrs & HAS_TEXCOORD) vertexSize += 2;
                primitive.vertexSize = vertexSize;
                primitive.vertexAttrs = gl.primitiveAttrs;
            }
            var vertex = new Float32Array(primitive.vertexSize);
            var offset = 0;
            vertex.set(position, offset); offset += 3;
            if (primitive.vertexAttrs & HAS_NORMAL) {
                vertex.set(gl.normal, offset); offset += 3;
            }
            if (primitive.vertexAttrs & HAS_COLOR) {
                vertex.set(gl.color, offset); offset += 4;
            }
            if (primitive.vertexAttrs & HAS_TEXCOORD) {
                vertex.set(gl.texCoord, offset); offset += 2;
            }
            primitive.vertices.push(vertex);
        },

        // shader source code
        vertexShaderSource: function(shaderFlags) {
            var src = [];
            src.push("uniform mat4 uModelView;");
            src.push("uniform mat4 uProjection;");
            src.push("attribute vec3 aPosition;");
            if (shaderFlags & HAS_NORMAL) {
                src.push("attribute vec3 aNormal;");
                src.push("varying vec3 vNormal;");
            }
            if (shaderFlags & HAS_COLOR) {
                src.push("attribute vec4 uColor;");
                src.push("varying vec4 vColor;");
            }
            if (shaderFlags & HAS_TEXCOORD) {
                src.push("attribute vec2 aTexCoord;");
                src.push("varying vec2 vTexCoord;");
            }
            if (shaderFlags & HAS_POINT_SIZE) {
                src.push("uniform float uPointSize;");
            }
            src.push("void main(void) {");
            if (shaderFlags & HAS_NORMAL) {
                src.push("  vNormal = aNormal;");
            }
            if (shaderFlags & HAS_COLOR) {
                src.push("  vColor = uColor;");
            }
            if (shaderFlags & HAS_TEXCOORD) {
                src.push("  vTexCoord = aTexCoord;");
            }
            if (shaderFlags & HAS_POINT_SIZE) {
                src.push("  gl_PointSize = uPointSize;");
            }
            src.push("  gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);");
            src.push("}");
            var src = src.join("\n");
            DEBUG > 1 && console.log(src);
            return src;
        },

        fragmentShaderSource: function(shaderFlags) {
            var src = [];
            src.push("precision mediump float;");
            if (shaderFlags & HAS_NORMAL) {
                src.push("varying vec3 vNormal;");
            }
            if (shaderFlags & HAS_COLOR) {
                src.push("varying vec4 vColor;");
            } else {
                src.push("uniform vec4 uColor;");
            }
            if (shaderFlags & HAS_TEXCOORD) {
                src.push("varying vec2 vTexCoord;");
            }
            if (shaderFlags & HAS_TEXTURE) {
                src.push("uniform sampler2D uSampler;");
            }
            src.push("void main(void) {");
            if (shaderFlags & HAS_NORMAL) {
                src.push("  vec3 normal = normalize(vNormal);");
            }
            if (shaderFlags & HAS_COLOR) {
                src.push("  vec4 color = vColor;");
            } else {
                src.push("  vec4 color = uColor;");
            }
            if ((shaderFlags & (HAS_TEXCOORD + HAS_TEXTURE)) === (HAS_TEXCOORD + HAS_TEXTURE)) {
                src.push("  color *= texture2D(uSampler, vec2(vTexCoord.s, vTexCoord.t)).bgra;");
            }
            if (shaderFlags & HAS_NORMAL) {
                src.push("  float diffuse = max(dot(normal, vec3(0, 0, 1)), 0.0);");
                src.push("  gl_FragColor = color * diffuse;");
            } else {
                src.push("  gl_FragColor = color;");
                // src.push("  gl_FragColor = mix(color, vec4(1, 0, 1, 1), 0.5);");
            }
            src.push("}");
            var src = src.join("\n");
            DEBUG > 1 && console.log(src);
            return src;
        },

        getLocations: function(program, shaderFlags) {
            var locations = {};
            // uniforms
            locations.uModelView = webgl.getUniformLocation(program, "uModelView");
            locations.uProjection = webgl.getUniformLocation(program, "uProjection");
            if (shaderFlags & HAS_TEXTURE) {
                locations.uSampler = webgl.getUniformLocation(program, "uSampler");
            }
            // attributes
            locations.aPosition = webgl.getAttribLocation(program, "aPosition");
            if (shaderFlags & HAS_NORMAL) {
                locations.aNormal = webgl.getAttribLocation(program, "aNormal");
            }
            if (shaderFlags & HAS_COLOR) {
                locations.aColor = webgl.getAttribLocation(program, "aColor");
            } else {
                locations.uColor = webgl.getUniformLocation(program, "uColor");
            }
            if (shaderFlags & HAS_TEXCOORD) {
                locations.aTexCoord = webgl.getAttribLocation(program, "aTexCoord");
            }
            if (shaderFlags & HAS_POINT_SIZE) {
                locations.uPointSize = webgl.getUniformLocation(program, "uPointSize");
            }
            DEBUG > 1 && console.log(locations);
            return locations;
        },

        executeList: function(listId) {
            var list = gl.lists[listId];
            if (!list) {
                DEBUG > 0 && console.warn("OpenGL: display list not found " + listId);
                return;
            }
            for (var i = 0; i < list.commands.length; i++) {
                var cmd = list.commands[i];
                this[cmd.name].apply(this, cmd.args);
            }
        },
    };
}

function transformPoint(matrix, src, dst) {
    var x = src[0];
    var y = src[1];
    var z = src[2];
    var rx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    var ry = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    var rz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    var rw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    if (rw === 1) {
        dst[0] = rx;
        dst[1] = ry;
        dst[2] = rz;
    } else {
        if (rw !== 0) rw = 1 / rw;
        dst[0] = rx * rw;
        dst[1] = ry * rw;
        dst[2] = rz * rw;
    }
    dst[3] = src[3];
}

function multMatrix(m1, m2) {
    for (var row = 0; row < 16; row += 4) {
        var c0 = m1[row+0] * m2[0] + m1[row+1] * m2[4] + m1[row+2] * m2[8] + m1[row+3] * m2[12];
        var c1 = m1[row+0] * m2[1] + m1[row+1] * m2[5] + m1[row+2] * m2[9] + m1[row+3] * m2[13];
        var c2 = m1[row+0] * m2[2] + m1[row+1] * m2[6] + m1[row+2] * m2[10] + m1[row+3] * m2[14];
        var c3 = m1[row+0] * m2[3] + m1[row+1] * m2[7] + m1[row+2] * m2[11] + m1[row+3] * m2[15];
        m1[row+0] = c0;
        m1[row+1] = c1;
        m1[row+2] = c2;
        m1[row+3] = c3;
    }
}

function translateMatrix(m, x, y, z) {
    m[12] += x * m[0] + y * m[4] + z * m[8];
    m[13] += x * m[1] + y * m[5] + z * m[9];
    m[14] += x * m[2] + y * m[6] + z * m[10];
    m[15] += x * m[3] + y * m[7] + z * m[11];
}

function rotateMatrix(m, angle, x, y, z) {
    // normalize axis vector
    var len = Math.sqrt(x * x + y * y + z * z);
    if (len === 0) return;
    if (len !== 1) {
        len = 1 / len;
        x *= len;
        y *= len;
        z *= len;
    }
    // create rotation matrix
    var degrees = Math.PI / 180;
    var c = Math.cos(angle * degrees);
    var s = Math.sin(angle * degrees);
    var t = 1 - c;
    var m00 = x * x * t + c;
    var m01 = x * y * t - z * s;
    var m02 = x * z * t + y * s;
    var m10 = y * x * t + z * s;
    var m11 = y * y * t + c;
    var m12 = y * z * t - x * s;
    var m20 = z * x * t - y * s;
    var m21 = z * y * t + x * s;
    var m22 = z * z * t + c;
    // multiply rotation matrix
    var m0 = m[0] * m00 + m[4] * m01 + m[8] * m02;
    var m1 = m[1] * m00 + m[5] * m01 + m[9] * m02;
    var m2 = m[2] * m00 + m[6] * m01 + m[10] * m02;
    var m3 = m[3] * m00 + m[7] * m01 + m[11] * m02;
    var m4 = m[0] * m10 + m[4] * m11 + m[8] * m12;
    var m5 = m[1] * m10 + m[5] * m11 + m[9] * m12;
    var m6 = m[2] * m10 + m[6] * m11 + m[10] * m12;
    var m7 = m[3] * m10 + m[7] * m11 + m[11] * m12;
    m[8] = m[0] * m20 + m[4] * m21 + m[8] * m22;
    m[9] = m[1] * m20 + m[5] * m21 + m[9] * m22;
    m[10] = m[2] * m20 + m[6] * m21 + m[10] * m22;
    m[11] = m[3] * m20 + m[7] * m21 + m[11] * m22;
    m[0] = m0;
    m[1] = m1;
    m[2] = m2;
    m[3] = m3;
    m[4] = m4;
    m[5] = m5;
    m[6] = m6;
    m[7] = m7;
}

function initGLConstants() {
    GL = {
        DEPTH_BUFFER_BIT:            0x00000100,
        STENCIL_BUFFER_BIT:          0x00000400,
        COLOR_BUFFER_BIT:            0x00004000,
        FALSE:                       0,
        TRUE:                        1,
        POINTS:                      0x0000,
        LINES:                       0x0001,
        LINE_LOOP:                   0x0002,
        LINE_STRIP:                  0x0003,
        TRIANGLES:                   0x0004,
        TRIANGLE_STRIP:              0x0005,
        TRIANGLE_FAN:                0x0006,
        QUADS:                       0x0007,
        QUAD_STRIP:                  0x0008,
        POLYGON:                     0x0009,
        NEVER:                       0x0200,
        LESS:                        0x0201,
        EQUAL:                       0x0202,
        LEQUAL:                      0x0203,
        GREATER:                     0x0204,
        NOTEQUAL:                    0x0205,
        GEQUAL:                      0x0206,
        ALWAYS:                      0x0207,
        ZERO:                        0,
        ONE:                         1,
        SRC_COLOR:                   0x0300,
        ONE_MINUS_SRC_COLOR:         0x0301,
        SRC_ALPHA:                   0x0302,
        ONE_MINUS_SRC_ALPHA:         0x0303,
        DST_ALPHA:                   0x0304,
        ONE_MINUS_DST_ALPHA:         0x0305,
        DST_COLOR:                   0x0306,
        ONE_MINUS_DST_COLOR:         0x0307,
        SRC_ALPHA_SATURATE:          0x0308,
        NONE:                        0,
        FRONT_LEFT:                  0x0400,
        FRONT_RIGHT:                 0x0401,
        BACK_LEFT:                   0x0402,
        BACK_RIGHT:                  0x0403,
        FRONT:                       0x0404,
        BACK:                        0x0405,
        LEFT:                        0x0406,
        RIGHT:                       0x0407,
        FRONT_AND_BACK:              0x0408,
        NO_ERROR:                    0,
        INVALID_ENUM:                0x0500,
        INVALID_VALUE:               0x0501,
        INVALID_OPERATION:           0x0502,
        OUT_OF_MEMORY:               0x0505,
        CW:                          0x0900,
        CCW:                         0x0901,
        POINT_SIZE:                  0x0B11,
        POINT_SIZE_RANGE:            0x0B12,
        POINT_SIZE_GRANULARITY:      0x0B13,
        LINE_SMOOTH:                 0x0B20,
        LINE_WIDTH:                  0x0B21,
        LINE_WIDTH_RANGE:            0x0B22,
        LINE_WIDTH_GRANULARITY:      0x0B23,
        LIST_INDEX:                  0x0B33,
        LIGHTING:                    0x0B50,
        ALPHA_TEST:                  0x0BC0,
        POLYGON_MODE:                0x0B40,
        POLYGON_SMOOTH:              0x0B41,
        CULL_FACE:                   0x0B44,
        CULL_FACE_MODE:              0x0B45,
        FRONT_FACE:                  0x0B46,
        DEPTH_RANGE:                 0x0B70,
        DEPTH_TEST:                  0x0B71,
        DEPTH_WRITEMASK:             0x0B72,
        DEPTH_CLEAR_VALUE:           0x0B73,
        DEPTH_FUNC:                  0x0B74,
        STENCIL_TEST:                0x0B90,
        STENCIL_CLEAR_VALUE:         0x0B91,
        STENCIL_FUNC:                0x0B92,
        STENCIL_VALUE_MASK:          0x0B93,
        STENCIL_FAIL:                0x0B94,
        STENCIL_PASS_DEPTH_FAIL:     0x0B95,
        STENCIL_PASS_DEPTH_PASS:     0x0B96,
        STENCIL_REF:                 0x0B97,
        STENCIL_WRITEMASK:           0x0B98,
        VIEWPORT:                    0x0BA2,
        MODELVIEW_MATRIX:            0x0BA6,
        PROJECTION_MATRIX:           0x0BA7,
        DITHER:                      0x0BD0,
        BLEND_DST:                   0x0BE0,
        BLEND_SRC:                   0x0BE1,
        BLEND:                       0x0BE2,
        LOGIC_OP_MODE:               0x0BF0,
        DRAW_BUFFER:                 0x0C01,
        READ_BUFFER:                 0x0C02,
        SCISSOR_BOX:                 0x0C10,
        SCISSOR_TEST:                0x0C11,
        COLOR_CLEAR_VALUE:           0x0C22,
        COLOR_WRITEMASK:             0x0C23,
        DOUBLEBUFFER:                0x0C32,
        STEREO:                      0x0C33,
        PERSPECTIVE_CORRECTION_HINT: 0x0C50,
        LINE_SMOOTH_HINT:            0x0C52,
        POLYGON_SMOOTH_HINT:         0x0C53,
        UNPACK_SWAP_BYTES:           0x0CF0,
        UNPACK_LSB_FIRST:            0x0CF1,
        UNPACK_ROW_LENGTH:           0x0CF2,
        UNPACK_SKIP_ROWS:            0x0CF3,
        UNPACK_SKIP_PIXELS:          0x0CF4,
        UNPACK_ALIGNMENT:            0x0CF5,
        PACK_SWAP_BYTES:             0x0D00,
        PACK_LSB_FIRST:              0x0D01,
        PACK_ROW_LENGTH:             0x0D02,
        PACK_SKIP_ROWS:              0x0D03,
        PACK_SKIP_PIXELS:            0x0D04,
        PACK_ALIGNMENT:              0x0D05,
        MAX_TEXTURE_SIZE:            0x0D33,
        MAX_VIEWPORT_DIMS:           0x0D3A,
        SUBPIXEL_BITS:               0x0D50,
        TEXTURE_1D:                  0x0DE0,
        TEXTURE_2D:                  0x0DE1,
        TEXTURE_WIDTH:               0x1000,
        TEXTURE_HEIGHT:              0x1001,
        TEXTURE_BORDER_COLOR:        0x1004,
        DONT_CARE:                   0x1100,
        FASTEST:                     0x1101,
        NICEST:                      0x1102,
        AMBIENT:                     0x1200,
        DIFFUSE:                     0x1201,
        SPECULAR:                    0x1202,
        POSITION:                    0x1203,
        SPOT_CUTOFF:                 0x1206,
        COMPILE:                     0x1300,
        COMPILE_AND_EXECUTE:         0x1301,
        BYTE:                        0x1400,
        UNSIGNED_BYTE:               0x1401,
        SHORT:                       0x1402,
        UNSIGNED_SHORT:              0x1403,
        INT:                         0x1404,
        UNSIGNED_INT:                0x1405,
        FLOAT:                       0x1406,
        STACK_OVERFLOW:              0x0503,
        STACK_UNDERFLOW:             0x0504,
        CLEAR:                       0x1500,
        AND:                         0x1501,
        AND_REVERSE:                 0x1502,
        COPY:                        0x1503,
        AND_INVERTED:                0x1504,
        NOOP:                        0x1505,
        XOR:                         0x1506,
        OR:                          0x1507,
        NOR:                         0x1508,
        EQUIV:                       0x1509,
        INVERT:                      0x150A,
        OR_REVERSE:                  0x150B,
        COPY_INVERTED:               0x150C,
        OR_INVERTED:                 0x150D,
        NAND:                        0x150E,
        SET:                         0x150F,
        EMISSION:                    0x1600,
        SHININESS:                   0x1601,
        AMBIENT_AND_DIFFUSE:         0x1602,
        COLOR_INDEXES:               0x1603,
        MODELVIEW:                   0x1700,
        PROJECTION:                  0x1701,
        TEXTURE:                     0x1702,
        COLOR:                       0x1800,
        DEPTH:                       0x1801,
        STENCIL:                     0x1802,
        STENCIL_INDEX:               0x1901,
        DEPTH_COMPONENT:             0x1902,
        RED:                         0x1903,
        GREEN:                       0x1904,
        BLUE:                        0x1905,
        ALPHA:                       0x1906,
        RGB:                         0x1907,
        RGBA:                        0x1908,
        POINT:                       0x1B00,
        LINE:                        0x1B01,
        FILL:                        0x1B02,
        KEEP:                        0x1E00,
        REPLACE:                     0x1E01,
        INCR:                        0x1E02,
        DECR:                        0x1E03,
        VENDOR:                      0x1F00,
        RENDERER:                    0x1F01,
        VERSION:                     0x1F02,
        EXTENSIONS:                  0x1F03,
        MODULATE:                    0x2100,
        TEXTURE_ENV_MODE:            0x2200,
        TEXTURE_ENV:                 0x2300,
        NEAREST:                     0x2600,
        LINEAR:                      0x2601,
        NEAREST_MIPMAP_NEAREST:      0x2700,
        LINEAR_MIPMAP_NEAREST:       0x2701,
        NEAREST_MIPMAP_LINEAR:       0x2702,
        LINEAR_MIPMAP_LINEAR:        0x2703,
        TEXTURE_MAG_FILTER:          0x2800,
        TEXTURE_MIN_FILTER:          0x2801,
        TEXTURE_WRAP_S:              0x2802,
        TEXTURE_WRAP_T:              0x2803,
        REPEAT:                      0x2901,
        CLIP_PLANE0:                 0x3000,
        CLIP_PLANE1:                 0x3001,
        CLIP_PLANE2:                 0x3002,
        CLIP_PLANE3:                 0x3003,
        LIGHT0:                      0x4000,
        LIGHT1:                      0x4001,
        LIGHT2:                      0x4002,
        LIGHT3:                      0x4003,
        LIGHT4:                      0x4004,
        LIGHT5:                      0x4005,
        LIGHT6:                      0x4006,
        LIGHT7:                      0x4007,
        BGRA:                        0x80E1,
        CLAMP_TO_EDGE:               0x812F,
        VERTEX_ARRAY:                0x8074,
        NORMAL_ARRAY:                0x8075,
        COLOR_ARRAY:                 0x8076,
        INDEX_ARRAY:                 0x8077,
        TEXTURE_COORD_ARRAY:         0x8078,
        TEXTURE_COMPRESSED:          0x86A1,
    };
    GL_Symbols = {};
    for (var name in GL) {
        var value = GL[name];
        GL_Symbols[value] = name;
    }
}

function GL_Symbol(constant) {
    if (typeof GL === "undefined") initGLConstants();
    return GL_Symbols[constant] || constant;
}

function registerOpenGL() {
    if (typeof Squeak === "object" && Squeak.registerExternalModule) {
        Squeak.registerExternalModule('GL', OpenGL());
    } else self.setTimeout(registerOpenGL, 100);
};

registerOpenGL();
