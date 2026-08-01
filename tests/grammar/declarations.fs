# SYNTAX TEST "source.foundryscript"

namespace Game.Combat
#         ^^^^^^^^^^^ entity.name.type.foundryscript

import Game.Entities
#      ^^^^^^^^^^^^^ entity.name.type.foundryscript

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
#                                ^^^^ storage.type.void.foundryscript

var items: Array = []
#          ^^^^^ entity.name.type.foundryscript

extends "res://base.fs"
# <- storage.modifier.extends.foundryscript
#       ^ punctuation.definition.string.begin.foundryscript

class_name Player extends Node2D
#          ^^^^^^ entity.name.type.foundryscript
#                         ^^^^^^ entity.name.type.foundryscript

func f() -> Dictionary[String, int]:
#    ^ entity.name.function.foundryscript
#           ^^^^^^^^^^ entity.name.type.foundryscript

var v: Vector4 = null
#      ^^^^^^^ entity.name.type.foundryscript
