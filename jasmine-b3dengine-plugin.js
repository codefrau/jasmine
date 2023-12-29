function B3DEnginePlugin() {
    "use strict";

    var DEBUG = 0; // 0 = off, 1 = some, 2 = lots

    return {
        getModuleName: function() { return 'Squeak3D (jasmine)'; },
        interpreterProxy: null,
        primHandler: null,

        setInterpreter: function(anInterpreter) {
            this.interpreterProxy = anInterpreter;
            this.primHandler = this.interpreterProxy.vm.primHandler;
            return true;
        },

        b3dInitializeRasterizerState: function(argCount) {
            // reset everything for new frame
            if (argCount !== 0) return false;
            DEBUG > 1 && console.log("Squeak3D: b3dInitializeRasterizerState");
            return true;
        },

        b3dTransformPrimitiveNormal: function(argCount) {
            if (argCount !== 1) return false;
            DEBUG > 0 && console.log("Squeak3D: b3dTransformPrimitiveNormal");
            var vtx = this.stackFloat32Array(2, 4);
            var matrix = this.stackFloat32Array(1, 16);
            var rescale = this.interpreterProxy.stackValue(0);
            if (!from || !matrix) return false;
            var doRescale;
            if (rescale.isNil) doRescale = this.analyzeMatrix3x3Length(matrix);
            else doRescale = rescale.isTrue;
            this.transformDirection(matrix, vtx, vtx, doRescale);
            this.interpreterProxy.pop(argCount);
        },

        b3dTransformPrimitivePosition: function(argCount) {
            if (argCount !== 1) return false;
            DEBUG > 0 && console.log("Squeak3D: b3dTransformPrimitivePosition");
            var vtx = this.stackFloat32Array(1, 4);
            var matrix = this.stackFloat32Array(0, 16);
            if (!from || !matrix) return false;
            this.transformPoint(matrix, vtx, vtx);
            this.interpreterProxy.pop(argCount);
        },

        b3dTransformPoint: function(argCount) {
            if (argCount !== 1) return false;
            DEBUG > 1 && console.log("Squeak3D: b3dTransformPoint");
            var matrix = this.stackFloat32Array(1, 16);
            var from = this.stackFloat32Array(0, 3);
            if (!matrix || !from) return false;
            var fromOop = this.interpreterProxy.stackObjectValue(0);
            var toOop = this.interpreterProxy.clone(fromOop);
            if (!toOop) return false;
            var to = toOop.wordsAsFloat32Array();
            this.transformPoint(matrix, from, to);
            this.interpreterProxy.pop(2);
            this.interpreterProxy.push(toOop);
            return true;
        },

        b3dOrthoNormInverseMatrix: function(argCount) {
            if (argCount !== 0) return false;
            DEBUG > 1 && console.log("Squeak3D: b3dOrthoNormInverseMatrix");
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

        b3dInplaceHouseHolderInvert(argCount) {
            if (argCount !== 0) return false;
            var rcvr = this.stackFloat32Array(0, 16);
            if (!rcvr) return false;
            var m = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
            var x = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
            var d = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

            for (var i = 0; i < 4; i++) {
                for (var j = 0; j < 4; j++)
                    m[i][j] = rcvr[i*4+j];
            }
            for (var j = 0; j < 4; j++) {
                var sigma = 0;
                for (var i = j; i < 4; i++)
                    sigma += m[i][j] * m[i][j];
                if (sigma < 1e-10) return false; // matrix is singular
                var s = m[j][j] < 0 ? Math.sqrt(sigma) : -Math.sqrt(sigma);
                for (var r = 0; r < 4; r++)
                    d[j][r] = s;
                var beta = 1 / (s * m[j][j] - sigma);
                m[j][j] -= s;
                // update remaining columns
                for (var k = j+1; k < 4; k++) {
                    var sum = 0;
                    for (var i = j; i < 4; i++)
                        sum += m[i][j] * m[i][k];
                    sum *= beta;
                    for (var i = j; i < 4; i++)
                        m[i][k] += m[i][j] * sum;
                }
                // update vector
                for (var r = 0; r < 4; r++) {
                    var sum = 0;
                    for (var i = j; i < 4; i++)
                        sum += x[i][r] * m[i][j];
                    sum *= beta;
                    for (var i = j; i < 4; i++)
                        x[i][r] += sum * m[i][j];
                }
            }
            // Now calculate result
            for (var r = 0; r < 4; r++) {
                for (var i = 3; i >= 0; i--) {
                    for (var j = i+1; j < 4; j++)
                        x[i][r] -= x[j][r] * m[i][j];
                    x[i][r] /= d[i][r];
                }
            }
            for (var i = 0; i < 4; i++) {
                for (var j = 0; j < 4; j++)
                    rcvr[i*4+j] = x[i][j];
            }
            return true;
        },

        b3dTransposeMatrix: function(argCount) {
            if (argCount !== 0) return false;
            DEBUG > 1 && console.log("Squeak3D: b3dTransposeMatrix");
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
            DEBUG > 0 && console.log("Squeak3D: b3dTransformDirection");
            var matrix = this.stackFloat32Array(1, 16);
            var from = this.stackFloat32Array(0, 3);
            if (!matrix || !from) return false;
            var fromOop = this.interpreterProxy.stackObjectValue(0);
            var toOop = this.interpreterProxy.clone(fromOop);
            if (!toOop) return false;
            var to = toOop.wordsAsFloat32Array();
            this.transformDirection(matrix, from, to);
            this.interpreterProxy.pop(2);
            this.interpreterProxy.push(toOop);
            return true;
        },

        b3dTransformMatrixWithInto: function(argCount) {
            if (argCount !== 3) return false;
            var m3 = this.stackFloat32Array(0, 16);
            var m2 = this.stackFloat32Array(1, 16);
            var m1 = this.stackFloat32Array(2, 16);
            if (!m1 || !m2 || !m3) return false;
            DEBUG > 1 && console.log("Squeak3D: b3dTransformMatrixWithInto");
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

        stackFloat32Array: function(stackIndex, length) {
            var a = this.interpreterProxy.stackObjectValue(stackIndex);
            if (!a.words || a.words.length !== length) return null;
            return a.wordsAsFloat32Array();
        },

        transformDirection: function(matrix, from, to, rescale) {
            var x = from[0];
            var y = from[1];
            var z = from[2];
            var rx = x * matrix[0] + y * matrix[1] + z * matrix[2];
            var ry = x * matrix[4] + y * matrix[5] + z * matrix[6];
            var rz = x * matrix[8] + y * matrix[9] + z * matrix[10];
            if (rescale) {
                var dot = rx * rx + ry * ry + rz * rz;
                if (dot < 1e-20 ) {
                    rx = 0;
                    ry = 0;
                    rz = 0;
                } else if (dot !== 1) {
                    dot = 1 / Math.sqrt(dot);
                    rx *= dot;
                    ry *= dot;
                    rz *= dot;
                }
            }
            to[0] = rx;
            to[1] = ry;
            to[2] = rz;
        },

        transformPoint: function(matrix, from, to) {
            var x = from[0];
            var y = from[1];
            var z = from[2];
            var rx = x * matrix[0] + y * matrix[1] + z * matrix[2] + matrix[3];
            var ry = x * matrix[4] + y * matrix[5] + z * matrix[6] + matrix[7];
            var rz = x * matrix[8] + y * matrix[9] + z * matrix[10] + matrix[11];
            var rw = x * matrix[12] + y * matrix[13] + z * matrix[14] + matrix[15];
            if (rw === 1) {
                to[0] = rx;
                to[1] = ry;
                to[2] = rz;
            } else {
                if (rw !== 0) rw = 1 / rw;
                to[0] = rx * rw;
                to[1] = ry * rw;
                to[2] = rz * rw;
            }
        },

        analyzeMatrix3x3Length: function(m) {
            var det = m[0] * m[5] * m[10] -
                m[2] * m[5] * m[8] +
                m[4] * m[9] * m[2] -
                m[6] * m[9] * m[0] +
                m[8] * m[1] * m[6] -
                m[10] * m[1] * m[4];
            return det < 0.99 || det > 1.01;
        },

    };
}

function registerB3DEnginePlugin() {
    if (typeof Squeak === "object" && Squeak.registerExternalModule) {
        Squeak.registerExternalModule('Squeak3D', B3DEnginePlugin());
    } else self.setTimeout(registerB3DEnginePlugin, 100);
};

registerB3DEnginePlugin();
