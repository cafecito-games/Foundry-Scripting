# SYNTAX TEST "source.foundryscript"

var sprite = $Sprite2D
#            ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#             ^^^^^^^^ meta.node-path.foundryscript variable.other.node.foundryscript

var child = $Enemy/Health
#           ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#            ^^^^^ meta.node-path.foundryscript variable.other.node.foundryscript
#                 ^ meta.node-path.foundryscript punctuation.separator.node.foundryscript
#                  ^^^^^^ meta.node-path.foundryscript variable.other.node.foundryscript

var unique = %HealthBar
#            ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#             ^^^^^^^^^ meta.node-path.foundryscript variable.other.node.foundryscript

var quoted = $"Some Node/Child"
#            ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#             ^^^^^^^^^^^^^^^^^ meta.node-path.foundryscript string.quoted.node.foundryscript

var triple_double = $"""Root/Child"""
#                   ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#                    ^^^^^^^^^^^^^^^^ meta.node-path.foundryscript string.quoted.node.foundryscript

var triple_single = $'''Root/Child'''
#                   ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#                    ^^^^^^^^^^^^^^^^ meta.node-path.foundryscript string.quoted.node.foundryscript

var e = $Player/for
#               ^^^ - keyword.control.loop.for.foundryscript

var g = $Node/class
#             ^^^^^ - storage.type.class.foundryscript

var h = %Unique/match
#               ^^^^^ - keyword.control.match.foundryscript

var b = x%y
#        ^ keyword.operator.arithmetic.foundryscript
#        ^ - punctuation.definition.node.foundryscript

var b = arr[0]%n
#             ^ keyword.operator.arithmetic.foundryscript
#             ^ - punctuation.definition.node.foundryscript

var u = %Unique
#       ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#        ^^^^^^ meta.node-path.foundryscript variable.other.node.foundryscript

var u = $%Unique/child
#       ^ meta.node-path.foundryscript punctuation.definition.node.foundryscript
#        ^ meta.node-path.foundryscript punctuation.definition.node.unique.foundryscript
#         ^^^^^^ meta.node-path.foundryscript variable.other.node.foundryscript
#               ^ meta.node-path.foundryscript punctuation.separator.node.foundryscript
#                ^^^^^ meta.node-path.foundryscript variable.other.node.foundryscript
