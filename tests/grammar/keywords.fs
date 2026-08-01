# SYNTAX TEST "source.foundryscript"

if health <= 0:
# <- keyword.control.conditional.foundryscript

while running:
# <- keyword.control.loop.while.foundryscript

await coroutine
# <- keyword.control.flow.await.foundryscript

func take_damage():
# <- storage.type.function.foundryscript

var health = 0
# <- storage.type.var.foundryscript

static func helper():
# <- storage.modifier.foundryscript

var is_ready = a and b
#                ^^^ keyword.operator.logical.foundryscript

var check = value is int
#                 ^^ keyword.operator.expression.is.foundryscript

var t = true
#       ^^^^ constant.language.foundryscript

var i = INF
#       ^^^ constant.language.numeric.foundryscript

yield
# <- invalid.illegal.yield.foundryscript
