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
#   ^^^^^^ - keyword

var async = 2
#   ^^^^^ - storage.modifier

if true:
    extend int uses Describable:
    #   ^^^^^^ - keyword

if true:
    annotation my_marker targets CLASS, METHOD
    #   ^^^^^^^^^^ - keyword

func handle(async: int):
#           ^^^^^ - storage.modifier

foo(async, 1)
#   ^^^^^ - storage.modifier

var config = {async = 1}
#              ^^^^^ - storage.modifier

var handler = get
#             ^^^ - storage.modifier.accessor.foundryscript

var targets = 5
#   ^^^^^^^ - keyword.other.targets.foundryscript

var class_name_helper = 1
#   ^^^^^^^^^^^^^^^^^^ - keyword

var iffy = true
#   ^^^^ - keyword

var information = 1
#   ^^^^^^^^^^^ - keyword

var nothing = 1
#   ^^^^^^^ - keyword

func async_handler():
#    ^^^^^^^^^^^^^ - storage.modifier

extended = 1
# <- - keyword

    get:
#   ^^^ storage.modifier.accessor.foundryscript

    get():
#   ^^^ storage.modifier.accessor.foundryscript

    set(value):
#   ^^^ storage.modifier.accessor.foundryscript

    get = get_health
#   ^^^ storage.modifier.accessor.foundryscript

var get = 5
#   ^^^ - storage.modifier

    dict = {get = 1}
#           ^^^ - storage.modifier

    obj.set = 3
#       ^^^ - storage.modifier
