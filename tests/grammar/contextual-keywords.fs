# SYNTAX TEST "source.foundryscript"

extend int uses Describable:
# <- keyword.declaration.extend.foundryscript
#      ^^^ entity.name.type.foundryscript

async func fetch() -> Coroutine[int]:
# <- storage.modifier.async.foundryscript

annotation my_marker targets CLASS, METHOD
# <- keyword.declaration.annotation.foundryscript
#                    ^^^^^^^ keyword.other.targets.foundryscript
#                            ^^^^^^^^^^^^^ support.constant.target.foundryscript

var extend = 1
#   ^^^^^^ - keyword.declaration.extend.foundryscript

var async = 2
#   ^^^^^ - storage.modifier.async.foundryscript

if true:
    extend int uses Describable:
#   ^^^^^^ - keyword.declaration.extend.foundryscript

if true:
    annotation my_marker targets CLASS, METHOD
#   ^^^^^^^^^^ - keyword.declaration.annotation.foundryscript

func handle(async: int):
#           ^^^^^ - storage.modifier.async.foundryscript

foo(async, 1)
#   ^^^^^ - storage.modifier.async.foundryscript

var config = {async = 1}
#              ^^^^^ - storage.modifier.async.foundryscript

var handler = get
#             ^^^ - storage.modifier.accessor.foundryscript

var targets = 5
#   ^^^^^^^ - keyword.other.targets.foundryscript

var class_name_helper = 1
#   ^^^^^^^^^^^^^^^^^^ - keyword.declaration.foundryscript

var iffy = true
#   ^^^^ - keyword.control.foundryscript

var information = 1
#   ^^^^^^^^^^^ - keyword.operator.word.foundryscript

var nothing = 1
#   ^^^^^^^ - keyword.operator.word.foundryscript

func async_handler():
#    ^^^^^^^^^^^^^ - storage.modifier.async.foundryscript

extended = 1
# <- - keyword.declaration.extend.foundryscript

    get:
#   ^^^ storage.modifier.accessor.foundryscript

    get():
#   ^^^ storage.modifier.accessor.foundryscript

    set(value):
#   ^^^ storage.modifier.accessor.foundryscript

    get = get_health
#   ^^^ storage.modifier.accessor.foundryscript

var get = 5
#   ^^^ - storage.modifier.accessor.foundryscript

    dict = {get = 1}
#           ^^^ - storage.modifier.accessor.foundryscript

    obj.set = 3
#       ^^^ - storage.modifier.accessor.foundryscript
