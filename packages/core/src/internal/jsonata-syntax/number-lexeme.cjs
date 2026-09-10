"use strict";
const grammar = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
exports.fromText = value => { if (!grammar.test(value)) throw new SyntaxError("Invalid numeric literal"); return value; };
exports.isNumeric = value => typeof value === "string" && grammar.test(value);
exports.text = value => value;
