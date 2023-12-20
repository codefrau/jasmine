Smalltalk organization addCategory: 'VersionNumber'!

Object subclass: #VersionHistory
	instanceVariableNames: 'versions '
	classVariableNames: ''
	poolDictionaries: ''
	category: 'VersionNumber'!

VersionHistory class
	instanceVariableNames: ''!

Magnitude subclass: #VersionNumber
	instanceVariableNames: 'numbers '
	classVariableNames: ''
	poolDictionaries: ''
	category: 'VersionNumber'!

VersionNumber class
	instanceVariableNames: ''!

!VersionHistory commentStamp: '<historical>' prior: 0!
I am a version history.  A version history is a collection of VersionNumbers that together form a tree of versions.  I enforce rules about how versions are added and removed from the history.

To add a new version to a VersionHistory based on an existing version:

  VersionHistory startingAt1 addNewVersionBasedOn: '1' asVersion; yourself

If you add 2 new versions based on the same version, a branch will be started:

  VersionHistory startingAt1 
		addNewVersionBasedOn: '1' asVersion;
		addNewVersionBasedOn: '1' asVersion; 
		yourself

To remove a single version (note: only versions at the tip of a branch, or at the base of the trunk (if it has only one successor) can be individually removed):

  VersionHistory startingAt1 
		addNewVersionBasedOn: '1' asVersion;
		addNewVersionBasedOn: '1' asVersion; 
		remove: '1.1' asVersion;
		yourself

To remove an entire branch:

  VersionHistory startingAt1 
		addNewVersionBasedOn: '1' asVersion;
		addNewVersionBasedOn: '1' asVersion; 
		addNewVersionBasedOn: '1.1' asVersion; 
		addNewVersionBasedOn: '1.2' asVersion; 
		removeBranch: '1.1' asVersion;
		yourself

To remove a portion of the trunk:

  VersionHistory startingAt1 
		addNewVersionBasedOn: '1' asVersion;
		addNewVersionBasedOn: '2' asVersion; 
		addNewVersionBasedOn: '3' asVersion; 
		addNewVersionBasedOn: '3' asVersion; 
		removeTrunk: '2' asVersion;
		yourself

To get a string description of a version history:

  VersionHistory startingAt1 
		addNewVersionBasedOn: '1' asVersion;
		addNewVersionBasedOn: '2' asVersion; 
		addNewVersionBasedOn: '3' asVersion; 
		addNewVersionBasedOn: '3' asVersion; 
		treeString

Also, the following methods are useful for accessing the versions:

	#firstVersion
	#versionBefore:
	#versionsAfter:
	#mainLineStartingAt:
	#allVersionsAfter:
	#allVersionsBefore:
!

!VersionNumber commentStamp: '<historical>' prior: 0!
I am a version number.  My representation allows me to handle an entire tree of versions.  Once created, an instance should not change (note: VersionNumbers could be canonicalized like Symbols, but are not currently).  

I am a magnitude so that you can see if one version preceeds another (only if the two versions are in the same branch).  

	'2.1' asVersion < '2.2.1' asVersion	"true"
	'2.3' asVersion < '2.2.1' asVersion	"error different branches"
	'2.3' asVersion inSameBranchAs: '2.2.1' asVersion	"false, why the previous one failed."	
	'2.1' asVersion = '2.1' asVersion		"true, obviously"

To get the next version number in the same branch:

	'2.3.4' asVersion next	"2.3.5"

To get the next version number, starting a new branch:

	'2.3.4' asVersion branchNext		"2.3.4.1"

To get the common base version of any two version numbers (useful for merging):

	'2.3.8' asVersion commonBase: '2.3.4.1' asVersion		"2.3.4"!

!VersionNumber methodsFor: 'comparing' stamp: 'svp 6/18/2002 15:05'!
< another 
	"Answer whether the receiver is less than the argument."

	| tmp |
	(self inSameBranchAs: another) ifFalse: 
		[^self error: 'Receiver and argument in different branches'].

	tmp := another numbers.
	(tmp size = numbers size) ifTrue:
		[1 to: numbers size do: 
			[ :in | (numbers at: in) < (tmp at: in) ifTrue: [^true]].
		^false].

	^numbers size < tmp size
! !

!VersionNumber methodsFor: 'comparing' stamp: 'svp 6/18/2002 15:10'!
= aVersion

	^numbers = aVersion numbers! !

!VersionHistory methodsFor: 'adding' stamp: 'svp 6/18/2002 17:17'!
addNewVersionBasedOn: aVersion

	| tmp |
	(versions includes: aVersion) ifFalse: [^self error: 'Version is not in this history'].

	tmp := aVersion next.
	(versions includes: tmp) ifFalse: 
		[versions add: tmp.
		^tmp].

	tmp := aVersion.
	[versions includes: (tmp := tmp branchNext)] whileTrue.
	versions add: tmp.
	^tmp
	! !

!VersionHistory methodsFor: 'accessing' stamp: 'svp 6/26/2002 16:32'!
allVersionsAfter: aVersion
	"Answer all the versions based on aVersion."

	| answer |
	answer := Set new.
	versions do: [ :ea |
		((ea inSameBranchAs: aVersion) and: 
			[ea > aVersion]) ifTrue: [answer add: ea]].
	^answer! !

!VersionHistory methodsFor: 'accessing' stamp: 'svp 6/26/2002 16:32'!
allVersionsBefore: aVersion
	"Answer all versions that came before aVersion"

	| answer |
	answer := Set new.
	versions do: [ :ea |
		((ea inSameBranchAs: aVersion) and: 
			[ea < aVersion]) ifTrue: [answer add: ea]].
	^answer! !

!String methodsFor: '*versionnumber' stamp: 'svp 6/18/2002 16:12'!
asVersion
	"Answer a VersionNumber"

	^VersionNumber fromString: self! !

!VersionNumber methodsFor: 'accessing' stamp: 'svp 6/18/2002 12:22'!
branchNext

	^self class fromCollection: (numbers, (Array with: 1))! !

!VersionHistory methodsFor: 'testing' stamp: 'svp 6/27/2002 14:09'!
canRemove: aVersion

	| hasPriors followers |
	(versions includes: aVersion) ifFalse: [^false].
	hasPriors := (self versionBefore: aVersion) notNil.
	followers := self versionsAfter: aVersion.		

	"Don't allow versions in the middle to be extracted"
	(hasPriors and: [followers size > 0]) ifTrue: [^false].
	
	"Don't allow versions with more than one follower to be extracted"
	(hasPriors not and: [followers size > 1]) ifTrue: [^false].
	^true

! !

!VersionNumber methodsFor: 'accessing' stamp: 'svp 6/18/2002 14:50'!
commonBase: aVersion

	| smallNums largeNums cutoff |
	(aVersion numbers size <= numbers size) 
		ifTrue: [smallNums := aVersion numbers. largeNums := numbers] 
		ifFalse: [smallNums := numbers. largeNums := aVersion numbers].

	cutoff := (1 to: smallNums size) 
		detect: [ :in | ((smallNums at: in) ~= (largeNums at: in))] 
		ifNone: [^self class fromCollection: smallNums].

	^self class fromCollection: 
		((numbers copyFrom: 1 to: (cutoff - 1)), 
		(Array with: ((smallNums at: cutoff) min: (largeNums at: cutoff))))
! !

!VersionNumber class methodsFor: 'as yet unclassified' stamp: 'svp 6/18/2002 16:34'!
first

	^self fromCollection: #(1)! !

!VersionHistory methodsFor: 'accessing' stamp: 'svp 6/26/2002 16:32'!
firstVersion
	"Answer the first version in the entire version history"

	^versions inject: versions anyOne into: [ :x :ea |
		(x inSameBranchAs: ea)
			ifTrue: [(x < ea) ifTrue: [x] ifFalse: [ea]]
			ifFalse: [ea]]! !

!VersionNumber class methodsFor: 'as yet unclassified' stamp: 'svp 6/18/2002 12:21'!
fromCollection: aCollection

	^self new
		initializeNumbers: aCollection;
		yourself! !

!VersionNumber class methodsFor: 'as yet unclassified' stamp: 'svp 6/18/2002 12:20'!
fromString: aString

	^self fromCollection: 
		((aString findTokens: '.') collect: [:ea | ea asNumber ])
	! !

!VersionNumber methodsFor: 'comparing' stamp: 'svp 6/18/2002 12:23'!
hash

	^numbers hash! !

!VersionNumber methodsFor: 'testing' stamp: 'svp 6/18/2002 14:57'!
inSameBranchAs: aVersion

	| less more |
	(aVersion numbers size <= numbers size) 
		ifTrue: [less := aVersion numbers. more := numbers] 
		ifFalse: [less := numbers. more := aVersion numbers].

	1 to: (less size - 1) do: [ :in | ((less at: in) = (more at: in)) ifFalse: [^false]].
	^less size = more size or:
		[(less at: less size) <= (more at: less size)]
! !

!VersionHistory methodsFor: 'testing' stamp: 'svp 6/18/2002 16:43'!
includesVersion: aVersion

	^versions includes: aVersion! !

!VersionNumber methodsFor: 'initialization' stamp: 'svp 6/18/2002 15:08'!
initializeNumbers: aCollection

	aCollection do: [ :ea | 
		ea <= 0 ifTrue: 
			[^self error: 'VersionNumbers cannot contain zero or negative numbers']].

	numbers := aCollection asArray! !

!VersionHistory methodsFor: 'initialization' stamp: 'svp 6/18/2002 17:15'!
initializeVersionsAt: aVersion

	versions := Set new.
	versions add: aVersion.! !

!VersionHistory methodsFor: 'accessing' stamp: 'svp 6/26/2002 16:35'!
mainLineStartingAt: aVersion
	"Answer all versions based on aVersion that are not branches (they have 
	the same number of digits with the same values, except the last value is
	greater than the last value of aVersion)."

	| answer tmp |
	answer := OrderedCollection new.
	tmp := aVersion.
	[versions includes: tmp] 
		whileTrue: 
			[answer add: tmp.
			tmp := tmp next].
	^answer
! !

!VersionNumber methodsFor: 'accessing' stamp: 'svp 6/18/2002 12:14'!
next

	| tmp |
	tmp := numbers copy.
	tmp at: numbers size put: (numbers last + 1).
	^self class fromCollection: tmp! !

!VersionNumber methodsFor: 'accessing' stamp: 'svp 6/18/2002 14:51'!
numbers
	"Answer a copy (to discourage people from directly changing a version number).
	VersionNumbers should never change, instead, instantiate a new instance."

	^numbers copy! !

!VersionNumber methodsFor: 'accessing' stamp: 'svp 6/18/2002 16:51'!
previous

	| tmp |
	numbers last = 1 ifTrue: 
		[^self class fromCollection: (numbers allButLast)].
	tmp := numbers copy.
	tmp at: numbers size put: (numbers last - 1).
	^self class fromCollection: tmp
! !

!VersionNumber methodsFor: 'printing' stamp: 'svp 6/18/2002 12:27'!
printOn: strm

	self storeOn: strm! !

!VersionHistory methodsFor: 'removing' stamp: 'svp 6/26/2002 16:30'!
remove: aVersion
	"Remove aVersion from this version history."

	^self remove: aVersion ifAbsent: [self error: 'version not found'].! !

!VersionHistory methodsFor: 'removing' stamp: 'svp 6/27/2002 14:08'!
remove: aVersion ifAbsent: aBlock
	"Remove aVersion from this version history."

	(versions includes: aVersion) ifFalse: [^aBlock value].

	(self canRemove: aVersion) ifFalse:
		[^self error: 'Only versions at the beginning or end with no more than one follower may be removed'].

	versions remove: aVersion.! !

!VersionHistory methodsFor: 'removing' stamp: 'svp 6/18/2002 17:48'!
removeBranch: aVersion
	"Remove aVersion and all of it's successors, providing that
	aVersion is not the first version."

	(self versionBefore: aVersion)
		ifNil: [^self error: 'version is the first version in the history'].

	versions removeAll: (self allVersionsAfter: aVersion).
	versions remove: aVersion.! !

!VersionHistory methodsFor: 'removing' stamp: 'svp 6/18/2002 17:47'!
removeTrunk: aVersion
	"Remove aVersion and all of it's predecessors, providing there
	are no other branches stemming from the trunk.  Note, a trunk is defined
	as all versions, starting with the first version, that have only one successor."

	| tmp |
	(self versionsAfter: aVersion) size > 1 
		ifTrue: [^self error: 'version is at a fork'].

	tmp := self allVersionsBefore: aVersion.
	(tmp detect: [ :ea | (self versionsAfter: ea) size > 1 ] ifNone: [nil])
		ifNotNil: [^self error: 'not a trunk, other branches detected'].

	versions removeAll: tmp.
	versions remove: aVersion.! !

!VersionHistory class methodsFor: 'as yet unclassified' stamp: 'svp 6/26/2002 16:20'!
startingAt1

	^self startingAt: '1' asVersion! !

!VersionHistory class methodsFor: 'as yet unclassified' stamp: 'svp 6/18/2002 17:14'!
startingAt: aVersion

	^self new
		initializeVersionsAt: aVersion;
		yourself! !

!VersionNumber methodsFor: 'printing' stamp: 'svp 6/18/2002 17:24'!
storeOn: strm

	strm nextPut: $'.
	self versionStringOn: strm.
	strm nextPutAll: ''' asVersion'.! !

!VersionHistory methodsFor: 'printing' stamp: 'svp 6/26/2002 16:30'!
treeString
	"Answer a string that show the entire version history with
	each branch starting on a new line"

	^self treeStringStartingAt: self firstVersion! !

!VersionHistory methodsFor: 'printing' stamp: 'svp 6/26/2002 16:26'!
treeStringOn: strm startingAt: aVersion

	| tmp |
	tmp := self mainLineStartingAt: aVersion.
	tmp do: [ :ea | ea versionStringOn: strm. strm space; space ].
	strm cr.
	tmp do: 
		[ :ea | 
		(versions includes: ea branchNext)
			ifTrue: [self treeStringOn: strm startingAt: ea branchNext]].! !

!VersionHistory methodsFor: 'printing' stamp: 'svp 6/26/2002 11:34'!
treeStringStartingAt: aVersion

	| strm |
	strm := WriteStream on: ''.
	self treeStringOn: strm startingAt: aVersion.
	^strm contents! !

!VersionHistory methodsFor: 'accessing' stamp: 'svp 6/26/2002 16:37'!
versionBefore: aVersion

	"Answer the version immediately preceeding aVersion."

	| tmp |
	(aVersion > '1' asVersion) ifFalse: [^nil].
	(versions includes: (tmp := aVersion previous)) ifFalse: [^nil].
	^tmp! !

!VersionNumber methodsFor: 'printing' stamp: 'svp 6/18/2002 17:23'!
versionStringOn: strm

	| first |
	first := true.
	numbers do: [ :ea |
		first ifFalse: [strm nextPut: $.].
		first := false.
		ea printOn: strm]
	! !

!VersionHistory methodsFor: 'accessing' stamp: 'svp 6/26/2002 16:37'!
versionsAfter: aVersion
	"Answer all the versions immediately following aVersion."

	| answer tmp |
	answer := Set new.
	tmp := aVersion next.
	(versions includes: aVersion next) ifTrue: [answer add: tmp].

	tmp := aVersion.
	[versions includes: (tmp := tmp branchNext)] whileTrue:
		[answer add: tmp].
	^answer! !

Smalltalk at: #FilePackageManager ifPresent: [:p | p registerPackage: 'VersionNumber'].!

