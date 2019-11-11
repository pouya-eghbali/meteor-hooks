// Import Tinytest from the tinytest Meteor package.
import { Tinytest } from "meteor/tinytest";

// Import and rename a variable exported by hooks.js.
import { name as packageName } from "meteor/akoerp:hooks";

// Write your tests here!
// Here is an example.
Tinytest.add('hooks - example', function (test) {
  test.equal(packageName, "hooks");
});
