'use strict';

class Greeter {
  constructor(options) {
    this.prefix = (options && options.prefix) || 'Hello';
    this.math = { add: (a, b) => a + b };
  }

  async greet(name) {
    return this.prefix + ', ' + name + '!';
  }
}

function shout(text) {
  return String(text).toUpperCase();
}

module.exports = { Greeter, shout };
