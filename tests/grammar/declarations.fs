# SYNTAX TEST "source.foundryscript"

namespace Game.Combat
#         ^^^^^^^^^^^ entity.name.namespace.foundryscript

import Game.Entities
#      ^^^^^^^^^^^^^ entity.name.namespace.foundryscript

class_name Player
#          ^^^^^^ entity.name.type.foundryscript

trait_name Damageable
#          ^^^^^^^^^^ entity.name.type.foundryscript

tuple_name Pair
#          ^^^^ entity.name.type.foundryscript

extends CharacterBody2D
#       ^^^^^^^^^^^^^^^ entity.name.type.foundryscript

uses Damageable
#    ^^^^^^^^^^ entity.name.type.foundryscript

func take_damage(amount: int) -> void:
#    ^^^^^^^^^^^ entity.name.function.foundryscript
#                        ^^^ support.type.builtin.foundryscript

var items: Array = []
#          ^^^^^ support.type.builtin.foundryscript

extends "res://base.fs"
# <- storage.modifier.foundryscript
#       ^ punctuation.definition.string.begin.foundryscript

class_name Player extends Node2D
#          ^^^^^^ entity.name.type.foundryscript
#                         ^^^^^^ entity.name.type.foundryscript

func f() -> Dictionary[String, int]:
#    ^ entity.name.function.foundryscript
#           ^^^^^^^^^^ support.type.builtin.foundryscript
#                      ^^^^^^ support.type.builtin.foundryscript
#                              ^^^ support.type.builtin.foundryscript
