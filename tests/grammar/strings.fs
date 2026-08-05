# SYNTAX TEST "source.foundryscript"

var a = "hello\n"
#       ^ punctuation.definition.string.begin.foundryscript
#             ^^ constant.character.escape.foundryscript

var b = 'single'
#       ^^^^^^^^ string.quoted.single.foundryscript

var c = &"string_name"
#       ^ storage.type.string.foundryscript

var d = ^"Node/Path"
#       ^ storage.type.string.foundryscript

var e = r"raw\nnot_escape"
#       ^ storage.type.string.foundryscript
#             ^^ string.quoted.double.raw.foundryscript

var f = """triple quoted"""
#       ^^^ punctuation.definition.string.begin.foundryscript

var g = '''triple single'''
#       ^^^ punctuation.definition.string.begin.foundryscript

var h = "bad \q escape"
#            ^^ string.quoted.double.foundryscript
#            ^^^ - constant.character.escape.foundryscript

var bad = "unterminated
var after = 1
#           ^ constant.numeric.integer.foundryscript

var cont = "a\
b"
# <- string.quoted.double.foundryscript

var rawc = r"a\
var after2 = 1
#            ^ constant.numeric.integer.foundryscript
