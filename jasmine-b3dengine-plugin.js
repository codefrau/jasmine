var DEBUG = false;

function B3DEnginePlugin() {
    "use strict";

    return {
        getModuleName: function() { return 'Squeak3D'; },
        interpreterProxy: null,
        primHandler: null,

        setInterpreter: function(anInterpreter) {
            this.interpreterProxy = anInterpreter;
            this.primHandler = this.interpreterProxy.vm.primHandler;
            return true;
        },

        b3dInitializeRasterizerState: function(argCount) {
            if (argCount !== 0) return false;
            DEBUG && console.log("Squeak3D: b3dInitializeRasterizerState");
            return true;
        },

        b3dTransformPoint: function(argCount) {
            if (argCount !== 1) return false;
            DEBUG && console.log("Squeak3D: b3dTransformPoint");
            var v3Oop = this.interpreterProxy.stackObjectValue(0);
            if (this.interpreterProxy.failed()) return false;
            if (!v3Oop.isWords || v3Oop.words.length !== 3) return false;
            var matrix = this.stackMatrix(1);
            if (!matrix) return false;
            var vertex = v3Oop.wordsAsFloat32Array();
            var x = vertex[0];
            var y = vertex[1];
            var z = vertex[2];
            var rx = x * matrix[0] + y * matrix[1] + z * matrix[2] + matrix[3];
            var ry = x * matrix[4] + y * matrix[5] + z * matrix[6] + matrix[7];
            var rz = x * matrix[8] + y * matrix[9] + z * matrix[10] + matrix[11];
            var rw = x * matrix[12] + y * matrix[13] + z * matrix[14] + matrix[15];
            v3Oop = this.interpreterProxy.clone(v3Oop);
            if (!v3Oop) return false;
            vertex = v3Oop.wordsAsFloat32Array();
            if (rw === 1) {
                vertex[0] = rx;
                vertex[1] = ry;
                vertex[2] = rz;
            } else {
                if (rw !== 0) rw = 1 / rw;
                vertex[0] = rx * rw;
                vertex[1] = ry * rw;
                vertex[2] = rz * rw;
            }
            this.interpreterProxy.pop(2);
            this.interpreterProxy.push(v3Oop);
            return true;
       },

        b3dOrthoNormInverseMatrix: function(argCount) {
            if (argCount !== 0) return false;
            DEBUG && console.log("Squeak3D: b3dOrthoNormInverseMatrix");
            var srcOop = this.interpreterProxy.stackObjectValue(0);
            if (this.interpreterProxy.failed()) return false;
            if (!srcOop.isWords || srcOop.words.length !== 16) return false;
            var dstOop = this.interpreterProxy.clone(srcOop);
            if (!dstOop) return false;
            var src = srcOop.wordsAsFloat32Array();
            var dst = dstOop.wordsAsFloat32Array();
            // Transpose upper 3x3 matrix
            /* dst[0] = src[0]; */ dst[1] = src[4]; dst[2] = src[8];
            dst[4] = src[1]; /* dst[5] = src[5]; */ dst[6] = src[9];
            dst[8] = src[2]; dst[9] = src[6]; /* dst[10] = src[10]; */
            // Compute inverse translation vector
            var x = src[3];
            var y = src[7];
            var z = src[11];
            var rx = x * dst[0] + y * dst[1] + z * dst[2];
            var ry = x * dst[4] + y * dst[5] + z * dst[6];
            var rz = x * dst[8] + y * dst[9] + z * dst[10];
            dst[3] = -rx;
            dst[7] = -ry;
            dst[11] = -rz;
            this.interpreterProxy.pop(1);
            this.interpreterProxy.push(dstOop);
            return true;
        },

        b3dTransposeMatrix: function(argCount) {
            if (argCount !== 0) return false;
            DEBUG && console.log("Squeak3D: b3dTransposeMatrix");
            var srcOop = this.interpreterProxy.stackObjectValue(0);
            if (this.interpreterProxy.failed()) return false;
            if (!srcOop.isWords || srcOop.words.length !== 16) return false;
            var dstOop = this.interpreterProxy.clone(srcOop);
            if (!dstOop) return false;
            var src = srcOop.wordsAsFloat32Array();
            var dst = dstOop.wordsAsFloat32Array();
            /* dst[0] = src[0]; */ dst[1] = src[4]; dst[2] = src[8]; dst[3] = src[12];
            dst[4] = src[1]; /* dst[5] = src[5]; */ dst[6] = src[9]; dst[7] = src[13];
            dst[8] = src[2]; dst[9] = src[6]; /* dst[10] = src[10]; */ dst[11] = src[14];
            dst[12] = src[3]; dst[13] = src[7]; dst[14] = src[11]; /* dst[15] = src[15]; */
            this.interpreterProxy.pop(1);
            this.interpreterProxy.push(dstOop);
            return true;
        },

        b3dTransformDirection: function(argCount) {
            if (argCount !== 1) return false;
            DEBUG && console.log("Squeak3D: b3dTransformDirection");
            var v3Oop = this.interpreterProxy.stackObjectValue(0);
            if (this.interpreterProxy.failed()) return false;
            if (!v3Oop.words || v3Oop.words.length !== 3) return false;
            var matrix = this.stackMatrix(1);
            if (!matrix) return false;
            var vertex = v3Oop.wordsAsFloat32Array();
            var x = vertex[0];
            var y = vertex[1];
            var z = vertex[2];
            var rx = x * matrix[0] + y * matrix[1] + z * matrix[2];
            var ry = x * matrix[4] + y * matrix[5] + z * matrix[6];
            var rz = x * matrix[8] + y * matrix[9] + z * matrix[10];
            v3Oop = this.interpreterProxy.clone(v3Oop);
            if (!v3Oop) return false;
            vertex = v3Oop.wordsAsFloat32Array();
            vertex[0] = rx;
            vertex[1] = ry;
            vertex[2] = rz;
            this.interpreterProxy.pop(2);
            this.interpreterProxy.push(v3Oop);
            return true;
        },

        b3dTransformMatrixWithInto: function(argCount) {
            if (argCount !== 3) return false;
            var m3 = this.stackMatrix(0);
            var m2 = this.stackMatrix(1);
            var m1 = this.stackMatrix(2);
            if (!m1 || !m2 || !m3) return false;
            DEBUG && console.log("Squeak3D: b3dTransformMatrixWithInto");
            for (var row = 0; row < 16; row += 4) {
                var c0 = m1[row+0] * m2[0] + m1[row+1] * m2[4] + m1[row+2] * m2[8] + m1[row+3] * m2[12];
                var c1 = m1[row+0] * m2[1] + m1[row+1] * m2[5] + m1[row+2] * m2[9] + m1[row+3] * m2[13];
                var c2 = m1[row+0] * m2[2] + m1[row+1] * m2[6] + m1[row+2] * m2[10] + m1[row+3] * m2[14];
                var c3 = m1[row+0] * m2[3] + m1[row+1] * m2[7] + m1[row+2] * m2[11] + m1[row+3] * m2[15];
                m3[row+0] = c0;
                m3[row+1] = c1;
                m3[row+2] = c2;
                m3[row+3] = c3;
            }
            this.interpreterProxy.pop(argCount);
            return true;
        },

        stackMatrix: function(stackIndex) {
            var m = this.interpreterProxy.stackObjectValue(stackIndex);
            if (!m.words || m.words.length !== 16) return null;
            return m.wordsAsFloat32Array();
        },
    };
}

function registerB3DEnginePlugin() {
    if (typeof Squeak === "object" && Squeak.registerExternalModule) {
        Squeak.registerExternalModule('Squeak3D', B3DEnginePlugin());
    } else self.setTimeout(registerB3DEnginePlugin, 100);
};

registerB3DEnginePlugin();
