# SYNTAX TEST "source.foundryscript"

if health <= 0:
# <- keyword.control.foundryscript

while running:
# <- keyword.control.foundryscript

await coroutine
# <- keyword.control.foundryscript

func take_damage():
# <- keyword.declaration.foundryscript

var health = 0
# <- keyword.declaration.foundryscript

static func helper():
# <- storage.modifier.foundryscript

var is_ready = a and b
#                ^^^ keyword.operator.word.foundryscript

var check = value is int
#                 ^^ keyword.operator.word.foundryscript

var t = true
#       ^^^^ constant.language.foundryscript

var i = INF
#       ^^^ constant.language.numeric.foundryscript

yield
# <- invalid.illegal.yield.foundryscript
