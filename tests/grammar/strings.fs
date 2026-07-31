# SYNTAX TEST "source.foundryscript"

var a = "hello\n"
#       ^ punctuation.definition.string.begin.foundryscript
#             ^^ constant.character.escape.foundryscript

var b = 'single'
#       ^^^^^^^^ string.quoted.foundryscript

var c = &"string_name"
#       ^ storage.type.string.foundryscript

var d = ^"Node/Path"
#       ^ storage.type.string.foundryscript

var e = r"raw\nnot_escape"
#       ^ storage.type.string.foundryscript
#             ^^ string.quoted.raw.foundryscript

var f = """triple quoted"""
#       ^^^ punctuation.definition.string.begin.foundryscript
