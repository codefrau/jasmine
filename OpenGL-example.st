'From Jasmine-rc1 of 7 October 2004 [latest update: #118] on 18 December 2023 at 11:08:52 pm'!

!OpenGL class methodsFor: 'as yet unclassified' stamp: 'sn 12/18/2023 23:06'!
example
	"OpenGL example"
	"A very simple OpenGL example"

	| ogl frames startTime deltaTime framesPerSec bounds font |
	"font := StrikeFont familyName: 'Atlanta' pointSize: 11."
	bounds _ 0 @ 0 extent: 400 @ 400.
	ogl _ OpenGL newIn: bounds.
	ogl
		ifNil: [^ self error: 'Unable to create renderer'].
	[frames _ 0.
	startTime _ Time millisecondClockValue.
	[Sensor anyButtonPressed]
		whileFalse: ["start counting at second frame since first frame is penalized
 by 
			the upload of the bitmap font outside of ogl."
			frames = 1
				ifTrue: [startTime _ Time millisecondClockValue].
			ogl beginFrame.
			"--- this is the actual scene content ---"
			ogl glDisable: GLDepthTest.
			"for the simple example only"
			ogl glDisable: GLLighting.
			"for the simple example only"
			ogl
				glClearColor: 1.0
				with: 1.0
				with: 1.0
				with: 1.0.
			ogl glClear: GLColorBufferBit.
			ogl
				glRotatef: 5.0
				with: 0.0
				with: 0.0
				with: 1.0.
			ogl
				glColor3f: 1.0
				with: 0.0
				with: 0.0.
			ogl glBegin: GLPolygon.
			ogl glVertex2f: -0.7 with: -0.7.
			ogl glVertex2f: 0.7 with: -0.7.
			ogl glVertex2f: 0.7 with: 0.7.
			ogl glVertex2f: -0.7 with: 0.7.
			ogl glEnd.
			"--- here is the 2d overlay setup ---"
			ogl glMatrixMode: GLProjection.
			ogl glPushMatrix.
			ogl glLoadIdentity.
			ogl glMatrixMode: GLModelview.
			ogl glPushMatrix.
			ogl glLoadIdentity.
			ogl
				glTranslated: -1
				with: 1
				with: 0.0.
			ogl
				glScaled: 2.0 / bounds width
				with: -2.0 / bounds height
				with: 1.0.
			ogl glDisable: GLDepthTest.
			ogl glEnable: GLBlend.
			ogl glBlendFunc: GLOne with: GLOneMinusSrcAlpha.
			"--- here is the 2d overlay rendering ---"
			deltaTime _ Time millisecondsSince: startTime.
			framesPerSec _ frames * 1000 / (deltaTime max: 1) asFloat.
			"@@@@: Fixme. It appears as if #drawString: depends on glColor 
			being set.
		Makes no sense but I'm not going to figure this out - 
			probably some mishap
		wrt. GLLighting being disabled."
			ogl
				glColor3f: 0.0
				with: 0.0
				with: 0.0.
			"ogl drawString: frames printString, ' frames: ', (framesPerSec 
			truncateTo: 0.1), ' fps'
			at: 0@font height@0 font: font color: 
			Color black."
			ogl glDisable: GLBlend.
			ogl glMatrixMode: GLModelview.
			ogl glPopMatrix.
			ogl glMatrixMode: GLProjection.
			ogl glPopMatrix.
			ogl glMatrixMode: GLModelview.
			"--- end the end frame operations"
			ogl endFrame.
			ogl swapBuffers.
			frames _ frames + 1]]
		ensure: [ogl destroy]! !