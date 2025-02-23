import _createClass from "@babel/runtime/helpers/createClass";
import deepEqual from 'deep-equal';
import { merge, BehaviorSubject } from 'rxjs';
import { mergeMap, filter, map, first, tap } from 'rxjs/operators';
import { massageSelector, filterInMemoryFields } from 'pouchdb-selector-core';
import { sortObject, stringifyFilter, pluginMissing, clone, overwriteGetterForCaching, now } from './util';
import { newRxError, newRxTypeError } from './rx-error';
import { runPluginHooks } from './hooks';
import { createRxDocuments } from './rx-document-prototype-merge';
import { calculateNewResults } from './event-reduce';
import { triggerCacheReplacement } from './query-cache';
var _queryCount = 0;

var newQueryID = function newQueryID() {
  return ++_queryCount;
};

export var RxQueryBase = /*#__PURE__*/function () {
  /**
   * Some stats then are used for debugging and cache replacement policies
   */
  // used by some plugins
  // used to count the subscribers to the query
  function RxQueryBase(op, mangoQuery, collection) {
    this.id = newQueryID();
    this._execOverDatabaseCount = 0;
    this._creationTime = now();
    this._lastEnsureEqual = 0;
    this.other = {};
    this.uncached = false;
    this.refCount$ = new BehaviorSubject(null);
    this._latestChangeEvent = -1;
    this._resultsData = null;
    this._resultsDataMap = new Map();
    this._lastExecStart = 0;
    this._lastExecEnd = 0;
    this._resultsDocs$ = new BehaviorSubject(null);
    this._ensureEqualQueue = Promise.resolve(false);
    this.op = op;
    this.mangoQuery = mangoQuery;
    this.collection = collection;

    if (!mangoQuery) {
      mangoQuery = _getDefaultQuery(this.collection);
    }
  }

  var _proto = RxQueryBase.prototype;

  /**
   * set the new result-data as result-docs of the query
   * @param newResultData json-docs that were recieved from pouchdb
   */
  _proto._setResultData = function _setResultData(newResultData) {
    this._resultsData = newResultData;
    var docs = createRxDocuments(this.collection, this._resultsData);

    this._resultsDocs$.next(docs);

    return docs;
  }
  /**
   * executes the query on the database
   * @return results-array with document-data
   */
  ;

  _proto._execOverDatabase = function _execOverDatabase() {
    var _this = this;

    this._execOverDatabaseCount = this._execOverDatabaseCount + 1;
    this._lastExecStart = now();
    var docsPromise;

    switch (this.op) {
      case 'find':
        docsPromise = this.collection._pouchFind(this);
        break;

      case 'findOne':
        docsPromise = this.collection._pouchFind(this, 1);
        break;

      default:
        throw newRxError('QU1', {
          collection: this.collection.name,
          op: this.op
        });
    }

    return docsPromise.then(function (docs) {
      _this._lastExecEnd = now();
      _this._resultsDataMap = new Map();
      var primPath = _this.collection.schema.primaryPath;
      docs.forEach(function (doc) {
        var id = doc[primPath];

        _this._resultsDataMap.set(id, doc);
      });
      return docs;
    });
  }
  /**
   * Execute the query
   * To have an easier implementations,
   * just subscribe and use the first result
   */
  ;

  _proto.exec = function exec(throwIfMissing) {
    var _this2 = this;

    // TODO this should be ensured by typescript
    if (throwIfMissing && this.op !== 'findOne') {
      throw newRxError('QU9', {
        collection: this.collection.name,
        query: this.mangoQuery,
        op: this.op
      });
    }
    /**
     * run _ensureEqual() here,
     * this will make sure that errors in the query which throw inside of pouchdb,
     * will be thrown at this execution context
     */


    return _ensureEqual(this).then(function () {
      return _this2.$.pipe(first()).toPromise();
    }).then(function (result) {
      if (!result && throwIfMissing) {
        throw newRxError('QU10', {
          collection: _this2.collection.name,
          query: _this2.mangoQuery,
          op: _this2.op
        });
      } else {
        return result;
      }
    });
  }
  /**
   * cached call to get the massageSelector
   * @overwrites itself with the actual value
   */
  ;

  /**
   * returns a string that is used for equal-comparisons
   * @overwrites itself with the actual value
   */
  _proto.toString = function toString() {
    var stringObj = sortObject({
      op: this.op,
      query: this.mangoQuery,
      other: this.other
    }, true);
    var value = JSON.stringify(stringObj, stringifyFilter);

    this.toString = function () {
      return value;
    };

    return value;
  }
  /**
   * returns the prepared query
   * @overwrites itself with the actual value
   */
  ;

  _proto.toJSON = function toJSON() {
    var value = this.collection.database.storage.prepareQuery(this.asRxQuery, clone(this.mangoQuery));

    this.toJSON = function () {
      return value;
    };

    return value;
  }
  /**
   * returns the key-compressed version of the query
   * @overwrites itself with the actual value
   */
  ;

  _proto.keyCompress = function keyCompress() {
    var value;

    if (!this.collection.schema.doKeyCompression()) {
      value = this.toJSON();
    } else {
      value = this.collection._keyCompressor.compressQuery(this.toJSON());
    }

    this.keyCompress = function () {
      return value;
    };

    return value;
  }
  /**
   * returns true if the document matches the query,
   * does not use the 'skip' and 'limit'
   * // TODO this was moved to rx-storage
   */
  ;

  _proto.doesDocumentDataMatch = function doesDocumentDataMatch(docData) {
    // if doc is deleted, it cannot match
    if (docData._deleted) return false;
    docData = this.collection.schema.swapPrimaryToId(docData); // return matchesSelector(docData, selector);

    /**
     * the following is equal to the implementation of pouchdb
     * we do not use matchesSelector() directly so we can cache the
     * result of massageSelector
     * @link https://github.com/pouchdb/pouchdb/blob/master/packages/node_modules/pouchdb-selector-core/src/matches-selector.js
     */

    var selector = this.massageSelector;
    var row = {
      doc: docData
    };
    var rowsMatched = filterInMemoryFields([row], {
      selector: selector
    }, Object.keys(selector));
    return rowsMatched && rowsMatched.length === 1;
  }
  /**
   * deletes all found documents
   * @return promise with deleted documents
   */
  ;

  _proto.remove = function remove() {
    var ret;
    return this.exec().then(function (docs) {
      ret = docs;
      if (Array.isArray(docs)) return Promise.all(docs.map(function (doc) {
        return doc.remove();
      }));else return docs.remove();
    }).then(function () {
      return ret;
    });
  }
  /**
   * helper function to transform RxQueryBase to RxQuery type
   */
  ;

  /**
   * updates all found documents
   * @overwritten by plugin (optional)
   */
  _proto.update = function update(_updateObj) {
    throw pluginMissing('update');
  } // we only set some methods of query-builder here
  // because the others depend on these ones
  ;

  _proto.where = function where(_queryObj) {
    throw pluginMissing('query-builder');
  };

  _proto.sort = function sort(_params) {
    throw pluginMissing('query-builder');
  };

  _proto.skip = function skip(_amount) {
    throw pluginMissing('query-builder');
  };

  _proto.limit = function limit(_amount) {
    throw pluginMissing('query-builder');
  };

  _createClass(RxQueryBase, [{
    key: "$",
    get: function get() {
      var _this3 = this;

      if (!this._$) {
        /**
         * We use _resultsDocs$ to emit new results
         * This also ensures that there is a reemit on subscribe
         */
        var results$ = this._resultsDocs$.pipe(mergeMap(function (docs) {
          return _ensureEqual(_this3).then(function (hasChanged) {
            if (hasChanged) return false; // wait for next emit
            else return docs;
          });
        }), filter(function (docs) {
          return !!docs;
        }), // not if previous returned false
        map(function (docs) {
          // findOne()-queries emit document or null
          if (_this3.op === 'findOne') {
            var doc = docs.length === 0 ? null : docs[0];
            return doc;
          } else return docs; // find()-queries emit RxDocument[]

        }), map(function (docs) {
          // copy the array so it wont matter if the user modifies it
          var ret = Array.isArray(docs) ? docs.slice() : docs;
          return ret;
        })).asObservable();
        /**
         * subscribe to the changeEvent-stream so it detects changes if it has subscribers
         */


        var changeEvents$ = this.collection.$.pipe(tap(function () {
          return _ensureEqual(_this3);
        }), filter(function () {
          return false;
        }));
        this._$ = // tslint:disable-next-line
        merge(results$, changeEvents$, this.refCount$.pipe(filter(function () {
          return false;
        })));
      }

      return this._$;
    } // stores the changeEvent-Number of the last handled change-event

  }, {
    key: "massageSelector",
    get: function get() {
      return overwriteGetterForCaching(this, 'massageSelector', massageSelector(this.mangoQuery.selector));
    }
  }, {
    key: "asRxQuery",
    get: function get() {
      return this;
    }
  }]);

  return RxQueryBase;
}();
export function _getDefaultQuery(collection) {
  var _selector;

  return {
    selector: (_selector = {}, _selector[collection.schema.primaryPath] = {}, _selector)
  };
}
/**
 * run this query through the QueryCache
 */

export function tunnelQueryCache(rxQuery) {
  return rxQuery.collection._queryCache.getByQuery(rxQuery);
}
export function createRxQuery(op, queryObj, collection) {
  // checks
  if (queryObj && typeof queryObj !== 'object') {
    throw newRxTypeError('QU7', {
      queryObj: queryObj
    });
  }

  if (Array.isArray(queryObj)) {
    throw newRxTypeError('QU8', {
      queryObj: queryObj
    });
  }

  runPluginHooks('preCreateRxQuery', {
    op: op,
    queryObj: queryObj,
    collection: collection
  });
  var ret = new RxQueryBase(op, queryObj, collection); // ensure when created with same params, only one is created

  ret = tunnelQueryCache(ret);
  runPluginHooks('createRxQuery', ret);
  triggerCacheReplacement(collection);
  return ret;
}
/**
 * check if the current results-state is in sync with the database
 * @return false if not which means it should re-execute
 */

function _isResultsInSync(rxQuery) {
  if (rxQuery._latestChangeEvent >= rxQuery.collection._changeEventBuffer.counter) {
    return true;
  } else return false;
}
/**
 * wraps __ensureEqual()
 * to ensure it does not run in parallel
 * @return true if has changed, false if not
 */


function _ensureEqual(rxQuery) {
  rxQuery._ensureEqualQueue = rxQuery._ensureEqualQueue.then(function () {
    return new Promise(function (res) {
      return setTimeout(res, 0);
    });
  }).then(function () {
    return __ensureEqual(rxQuery);
  }).then(function (ret) {
    return new Promise(function (res) {
      return setTimeout(res, 0);
    }).then(function () {
      return ret;
    });
  });
  return rxQuery._ensureEqualQueue;
}
/**
 * ensures that the results of this query is equal to the results which a query over the database would give
 * @return true if results have changed
 */


function __ensureEqual(rxQuery) {
  rxQuery._lastEnsureEqual = now();

  if (rxQuery.collection.database.destroyed) {
    // db is closed
    return false;
  }

  if (_isResultsInSync(rxQuery)) {
    // nothing happend
    return false;
  }

  var ret = false;
  var mustReExec = false; // if this becomes true, a whole execution over the database is made

  if (rxQuery._latestChangeEvent === -1) {
    // have not executed yet -> must run
    mustReExec = true;
  }
  /**
   * try to use the queryChangeDetector to calculate the new results
   */


  if (!mustReExec) {
    var missedChangeEvents = rxQuery.collection._changeEventBuffer.getFrom(rxQuery._latestChangeEvent + 1);

    if (missedChangeEvents === null) {
      // changeEventBuffer is of bounds -> we must re-execute over the database
      mustReExec = true;
    } else {
      rxQuery._latestChangeEvent = rxQuery.collection._changeEventBuffer.counter;
      /**
       * because pouchdb prefers writes over reads,
       * we have to filter out the events that happend before the read has started
       * so that we do not fill event-reduce with the wrong data
       */

      missedChangeEvents = missedChangeEvents.filter(function (cE) {
        return !cE.startTime || cE.startTime > rxQuery._lastExecStart;
      });

      var runChangeEvents = rxQuery.collection._changeEventBuffer.reduceByLastOfDoc(missedChangeEvents);
      /*
      console.log('calculateNewResults() ' + new Date().getTime());
      console.log(rxQuery._lastExecStart + ' - ' + rxQuery._lastExecEnd);
      console.dir(rxQuery._resultsData.slice());
      console.dir(runChangeEvents);
      */


      var eventReduceResult = calculateNewResults(rxQuery, runChangeEvents);

      if (eventReduceResult.runFullQueryAgain) {
        // could not calculate the new results, execute must be done
        mustReExec = true;
      } else if (eventReduceResult.changed) {
        // we got the new results, we do not have to re-execute, mustReExec stays false
        ret = true; // true because results changed

        rxQuery._setResultData(eventReduceResult.newResults);
      }
    }
  } // oh no we have to re-execute the whole query over the database


  if (mustReExec) {
    // counter can change while _execOverDatabase() is running so we save it here
    var latestAfter = rxQuery.collection._changeEventBuffer.counter;
    return rxQuery._execOverDatabase().then(function (newResultData) {
      rxQuery._latestChangeEvent = latestAfter;

      if (!deepEqual(newResultData, rxQuery._resultsData)) {
        ret = true; // true because results changed

        rxQuery._setResultData(newResultData);
      }

      return ret;
    });
  }

  return ret; // true if results have changed
}

export function isInstanceOf(obj) {
  return obj instanceof RxQueryBase;
}
//# sourceMappingURL=rx-query.js.map