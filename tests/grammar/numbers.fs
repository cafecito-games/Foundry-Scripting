# SYNTAX TEST "source.foundryscript"

var a = 100
#       ^^^ constant.numeric.integer.foundryscript

var b = 1_000_000
#       ^^^^^^^^^ constant.numeric.integer.foundryscript

var c = 0xFF_00
#       ^^^^^^^ constant.numeric.hex.foundryscript

var d = 0b1010
#       ^^^^^^ constant.numeric.binary.foundryscript

var e = 3.14
#       ^^^^ constant.numeric.float.foundryscript

var f = 1e10
#       ^^^^ constant.numeric.float.foundryscript

var g = 1..2
#       ^ constant.numeric.integer.foundryscript
#          ^ constant.numeric.integer.foundryscript

var t = tup.0
#           ^ - constant.numeric.integer.foundryscript
