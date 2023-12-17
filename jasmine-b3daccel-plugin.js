function B3DAcceleratorPlugin() {
    "use strict";

    var DEBUG = false;

    /* Renderer creation flags:
        B3D_SOFTWARE_RENDERER: Enable use of software renderers
        B3D_HARDWARE_RENDERER: Enable use of hardware renderers
        B3D_STENCIL_BUFFER:    Request stencil buffer
        B3D_ANTIALIASING:      Request antialiasing in the renderer.
        B3D_STEREO:            Request stereo visual from the renderer
        B3D_SYNCVBL:           Request VBL sync
        More flags may be added - if they are not supported by the platform
        code the creation primitive should fail.
    */
    var B3D_SOFTWARE_RENDERER = 0x0001;
    var B3D_HARDWARE_RENDERER = 0x0002;
    var B3D_STENCIL_BUFFER    = 0x0004;
    var B3D_ANTIALIASING      = 0x0008;
    var B3D_STEREO            = 0x0010;
    var B3D_SYNCVBL           = 0x0020;

    return {
        getModuleName: function() { return 'B3DAcceleratorPlugin'; },
        interpreterProxy: null,
        primHandler: null,

        webglContext: null, // accessed by OpenGL plugin

        setInterpreter: function(anInterpreter) {
            this.interpreterProxy = anInterpreter;
            this.primHandler = this.interpreterProxy.vm.primHandler;
            return true;
        },

        primitiveAllocateTexture: function(argCount) {
            if (argCount !== 4) return false;
            var h = this.interpreterProxy.stackIntegerValue(0);
            var w = this.interpreterProxy.stackIntegerValue(1);
            var d = this.interpreterProxy.stackIntegerValue(2);
            var renderer = this.interpreterProxy.stackIntegerValue(3);
            DEBUG && console.log("B3DAccel: UNIMPLEMENTED primitiveAllocateTexture", renderer, w, h, d);
            var texture = 4242;
            return this.primHandler.popNandPushIfOK(argCount + 1, texture);
        },
        primitiveSetVerboseLevel: function(argCount) {
            if (argCount !== 1) return false;
            var level = this.interpreterProxy.stackIntegerValue(0);
            DEBUG && console.log("B3DAccel: primitiveSetVerboseLevel", level);
            this.interpreterProxy.pop(argCount);
            return true;
        },

        primitiveCreateRendererFlags: function(argCount) {
            if (argCount !== 5) return false;
            var flags = this.interpreterProxy.stackIntegerValue(4);
            var x = this.interpreterProxy.stackIntegerValue(3);
            var y = this.interpreterProxy.stackIntegerValue(2);
            var w = this.interpreterProxy.stackIntegerValue(1);
            var h = this.interpreterProxy.stackIntegerValue(0);
            DEBUG && console.log("B3DAccel: primitiveCreateRendererFlags", x, y, w, h, flags);
            if (flags & ~(B3D_HARDWARE_RENDERER | B3D_SOFTWARE_RENDERER | B3D_STENCIL_BUFFER))
                return false;
            // create WebGL canvas
            var canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.style.backgroundColor = "transparent";
            canvas.style.pointerEvents = "none";
            document.body.appendChild(canvas);
            var options = { depth: true, alpha: false, antialias: true };
            if (flags & B3D_STENCIL_BUFFER) options.stencil = true;
            var context = canvas.getContext("webgl", options);
            if (!context) return false;
            // set context globally for OpenGL plugin
            this.webglCanvas = canvas;
            this.webglContext = context;
            // create handle
            var handle = this.primHandler.makeStString("WebGL(" + x + "," + y + "," + w + "," + h + ")");
            handle.canvas = canvas;
            handle.context = context;
            // set viewport
            this.b3dxSetViewport(handle, x, y, w, h);
            return this.primHandler.popNandPushIfOK(argCount + 1, handle);
        },

        primitiveDestroyRenderer: function(argCount) {
            if (argCount !== 1) return false;
            var handle = this.interpreterProxy.stackValue(0);
            DEBUG && console.log("B3DAccel: primitiveDestroyRenderer", handle);
            debugger;
            handle.canvas.remove();
            this.webglCanvas = null;
            this.webglContext = null;
            this.interpreterProxy.pop(argCount);
            return true;
        },

        primitiveGetRendererSurfaceHandle: function(argCount) {
            if (argCount !== 1) return false;
            var handle = this.interpreterProxy.stackValue(0);
            DEBUG && console.log("B3DAccel: primitiveGetRendererSurfaceHandle", handle);
            var surface = 4242;
            return this.primHandler.popNandPushIfOK(argCount + 1, surface);
        },

        primitiveGetIntProperty: function(argCount) {
            if (argCount !== 2) return false;
            var property = this.interpreterProxy.stackIntegerValue(0);
            var handle = this.interpreterProxy.stackValue(1);
            DEBUG && console.log("B3DAccel: primitiveGetIntProperty", handle, property);
            var value = this.b3dxGetIntProperty(handle, property);
            return this.primHandler.popNandPushIfOK(argCount + 1, value);
        },

        primitiveGetRendererSurfaceWidth: function(argCount) {
            if (argCount !== 1) return false;
            var handle = this.interpreterProxy.stackValue(0);
            var width = 800;
            DEBUG && console.log("B3DAccel: primitiveGetRendererSurfaceWidth", width);
            return this.primHandler.popNandPushIfOK(argCount + 1, width);
        },

        primitiveGetRendererSurfaceHeight: function(argCount) {
            if (argCount !== 1) return false;
            var handle = this.interpreterProxy.stackValue(0);
            var height = 600;
            DEBUG && console.log("B3DAccel: primitiveGetRendererSurfaceHeight", height);
            return this.primHandler.popNandPushIfOK(argCount + 1, height);
        },

        primitiveGetRendererSurfaceDepth: function(argCount) {
            if (argCount !== 1) return false;
            var handle = this.interpreterProxy.stackValue(0);
            var depth = 32;
            DEBUG && console.log("B3DAccel: primitiveGetRendererSurfaceDepth", depth);
            return this.primHandler.popNandPushIfOK(argCount + 1, depth);
        },

        primitiveGetRendererColorMasks: function(argCount) {
            if (argCount !== 2) return false;
            var array = this.interpreterProxy.stackObjectValue(0);
            var handle = this.interpreterProxy.stackValue(1);
            if (array.pointersSize() !== 4) return false;
            var masks = [0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000];
            for (var i = 0; i < 4; i++) {
                array.pointers[i] = this.interpreterProxy.positive32BitIntegerFor(masks[i]);
            }
            DEBUG && console.log("B3DAccel: primitiveGetRendererColorMasks", masks);
            this.interpreterProxy.pop(argCount);
            return true;
        },

        primitiveSetViewport: function(argCount) {
            if (argCount !== 5) return false;
            var h = this.interpreterProxy.stackIntegerValue(0);
            var w = this.interpreterProxy.stackIntegerValue(1);
            var y = this.interpreterProxy.stackIntegerValue(2);
            var x = this.interpreterProxy.stackIntegerValue(3);
            var handle = this.interpreterProxy.stackValue(4);
            DEBUG && console.log("B3DAccel: primitiveSetViewport", x, y, w, h);
            this.b3dxSetViewport(handle, x, y, w, h);
            this.interpreterProxy.pop(argCount);
            return true;
        },

        primitiveSetTransform: function(argCount) {
            if (argCount !== 3) return false;
            var handle = this.interpreterProxy.stackValue(2);
            var modelViewMatrix = this.stackMatrix(1);
            var projectionMatrix = this.stackMatrix(0);
            if (!modelViewMatrix || !projectionMatrix) return false;
            DEBUG && console.log("B3DAccel: primitiveSetTransform", projectionMatrix, modelViewMatrix);
            this.b3dxSetTransform(handle, projectionMatrix, modelViewMatrix);
            this.interpreterProxy.pop(argCount);
            return true;
        },

        primitiveSetLights: function(argCount) {
            if (argCount !== 2) return false;
            var handle = this.interpreterProxy.stackValue(1);
            var lightArray = this.interpreterProxy.stackObjectValue(0);
            if (this.interpreterProxy.failed()) return false;
            if (!this.b3dxDisableLights(handle)) return false;
            if (!lightArray) return false;
            DEBUG && console.log("B3DAccel: primitiveSetLights", lightArray);
            var lightCount = lightArray.pointersSize();
            for (var i = 0; i < lightCount; i++) {
                var light = this.fetchLightSource(i, lightArray);
                if (!this.b3dxLoadLight(handle, i, light)) return false;
            }
            this.interpreterProxy.pop(argCount);
            return true;
        },

        primitiveSetMaterial: function(argCount) {
            if (argCount !== 2) return false;
            var handle = this.interpreterProxy.stackValue(1);
            var material = this.stackMaterialValue(0);
            if (!material) return false;
            if (!this.b3dxLoadMaterial(handle, material)) return false;
            this.interpreterProxy.pop(argCount);
            return true;
        },

        primitiveSwapRendererBuffers: function(argCount) {
            if (argCount !== 1) return false;
            var handle = this.interpreterProxy.stackValue(0);
            DEBUG && console.log("B3DAccel: primitiveSwapRendererBuffers", handle);
            // let browser display the rendered frame
            this.interpreterProxy.vm.breakNow();
            // debugger; // wait after each frame
            this.interpreterProxy.pop(argCount);
            return true;
        },

        b3dxSetViewport: function(handle, x, y, w, h) {
            var canvas = handle.canvas;
            var scale = this.primHandler.display.initialScale || 1;
            canvas.style.left = (x * scale) + "px";
            canvas.style.top = (y * scale) + "px";
            canvas.style.width = (w * scale) + "px";
            canvas.style.height = (h * scale) + "px";
        },

        b3dxSetTransform: function(handle, projectionMatrix, modelViewMatrix) {
            DEBUG && console.log("B3DAccel: b3dxSetTransform", handle, projectionMatrix, modelViewMatrix);
        },

        b3dxDisableLights: function(handle) {
            DEBUG && console.log("B3DAccel: b3dxDisableLights", handle);
            return true;
        },

        b3dxLoadLight: function(handle, index, light) {
            DEBUG && console.log("B3DAccel: b3dxLoadLight", handle, index, light);
            return true;
        },

        b3dxLoadMaterial: function(handle, material) {
            DEBUG && console.log("B3DAccel: b3dxLoadMaterial", handle, material);
            return true;
        },

        b3dxGetIntProperty: function(handle, prop) {
            DEBUG && console.log("B3DAccel: b3dxGetIntProperty", handle, prop);
            // switch (prop) {
            //     case 1: /* backface culling */
            //         if (!glIsEnabled(GL_CULL_FACE)) return 0;
            //         glGetIntegerv(GL_FRONT_FACE, & v);
            //         if (v == GL_CW) return 1;
            //         if (v == GL_CCW) return -1;
            //         return 0;
            //     case 2: /* polygon mode */
            //         glGetIntegerv(GL_POLYGON_MODE, & v);
            //         ERROR_CHECK;
            //         return v;
            //     case 3: /* point size */
            //         glGetIntegerv(GL_POINT_SIZE, & v);
            //         ERROR_CHECK;
            //         return v;
            //     case 4: /* line width */
            //         glGetIntegerv(GL_LINE_WIDTH, & v);
            //         ERROR_CHECK;
            //         return v;
            //     case 5: /* blend enable */
            //         return glIsEnabled(GL_BLEND);
            //     case 6: /* blend source factor */
            //     case 7: /* blend dest factor */
            //         if (prop == 6)
            //             glGetIntegerv(GL_BLEND_SRC, & v);
            //         else
            //             glGetIntegerv(GL_BLEND_DST, & v);
            //         ERROR_CHECK;
            //         switch (v) {
            //             case GL_ZERO: return 0;
            //             case GL_ONE: return 1;
            //             case GL_SRC_COLOR: return 2;
            //             case GL_ONE_MINUS_SRC_COLOR: return 3;
            //             case GL_DST_COLOR: return 4;
            //             case GL_ONE_MINUS_DST_COLOR: return 5;
            //             case GL_SRC_ALPHA: return 6;
            //             case GL_ONE_MINUS_SRC_ALPHA: return 7;
            //             case GL_DST_ALPHA: return 8;
            //             case GL_ONE_MINUS_DST_ALPHA: return 9;
            //             case GL_SRC_ALPHA_SATURATE: return 10;
            //             default: return -1;
            //         }
            // }
            return 0;
        },


        fetchLightSource: function(index, lightArray) {
            var light = lightArray.pointers[index];
            if (!light) return null;
            DEBUG && console.log("B3DAccel: fetchLightSource", index, light);
            return light;
        },

        stackMatrix: function(stackIndex) {
            var m = this.interpreterProxy.stackObjectValue(stackIndex);
            if (!m.words || m.words.length !== 16) return null;
            return m.wordsAsFloat32Array();
        },

        stackMaterialValue: function(stackIndex) {
            var material = this.interpreterProxy.stackObjectValue(stackIndex);
            if (!material.pointers) return null;
            return material;
        },

    }
}

function registerB3DAcceleratorPlugin() {
    if (typeof Squeak === "object" && Squeak.registerExternalModule) {
        Squeak.registerExternalModule('B3DAcceleratorPlugin', B3DAcceleratorPlugin());
    } else self.setTimeout(registerB3DAcceleratorPlugin, 100);
};

registerB3DAcceleratorPlugin();
