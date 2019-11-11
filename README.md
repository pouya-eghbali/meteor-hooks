# Meteor hooks

I created this module because of [a bug in meteor-collecton-hooks](https://github.com/Meteor-Community-Packages/meteor-collection-hooks/issues/257). This module tries to achieve similar functionality as `mat33b:collection-hooks`, but does not try to be 100% compatible.

## Differences

* Uses Observe to run the hooks
* Is cluster aware
* Does not block
* No UserId passed to hooks
* before hooks receive arguments passed to the matching mongodb method
* after.insert hook receives one argument: document
* after.remove hook receives one argument: document
* after.update hook receives two arguments: current, previous
* a `hookMeta` field is added to all documents (Which holds userId, hook uuid, timestamp, and direct)
* Collection.original.method holds the original method, Collection.direct.method sets direct to true in hookMeta, collection.method sets direct to false in hookMeta.

## Installation

Create a packages directory in your meteor project, add this repository as a submodule in your packages directory (or just clone it). Then `meteor add akoerp:hooks`

## Documentation

WIP
