# SYNTAX TEST "source.foundryscript"

extend int uses Describable:
# <- storage.modifier.extend.foundryscript
#      ^^^ entity.name.type.foundryscript

async func fetch() -> Coroutine[int]:
# <- storage.modifier.async.foundryscript

annotation my_marker() targets CLASS, METHOD
# <- storage.type.annotation.foundryscript
#                       ^^^^^^ keyword.other.targets.foundryscript

var extend = 1
#   ^^^^^^ - storage.modifier.extend.foundryscript

var async = 2
#   ^^^^^ - storage.modifier.async.foundryscript

if true:
    extend int uses Describable:
#   ^^^^^^ storage.modifier.extend.foundryscript

if true:
    annotation my_marker targets CLASS, METHOD
#   ^^^^^^^^^^ storage.type.annotation.foundryscript

func handle(async: int):
#           ^^^^^ - storage.modifier.async.foundryscript

foo(async, 1)
#   ^^^^^ - storage.modifier.async.foundryscript

var config = {async = 1}
#              ^^^^^ - storage.modifier.async.foundryscript

var handler = get
#             ^^^ - storage.type.accessor.foundryscript

var targets = 5
#   ^^^^^^^ - keyword.other.targets.foundryscript

var class_name_helper = 1
#   ^^^^^^^^^^^^^^^^^^ - storage.type.class.foundryscript

var iffy = true
#   ^^^^ - keyword.control.conditional.foundryscript

var information = 1
#   ^^^^^^^^^^^ - keyword.operator.expression.in.foundryscript

var nothing = 1
#   ^^^^^^^ - keyword.operator.logical.foundryscript

func async_handler():
#    ^^^^^^^^^^^^^ - storage.modifier.async.foundryscript

extended = 1
# <- - storage.modifier.extend.foundryscript

    get:
#   ^^^ storage.type.accessor.foundryscript

    get():
#   ^^^ storage.type.accessor.foundryscript

    set(value):
#   ^^^ storage.type.accessor.foundryscript

    get = get_health
#   ^^^ storage.type.accessor.foundryscript

var get = 5
#   ^^^ - storage.type.accessor.foundryscript

    dict = {get = 1}
#           ^^^ - storage.type.accessor.foundryscript

    obj.set = 3
#       ^^^ - storage.type.accessor.foundryscript
