MARIONETTE_CONTEXT = "chrome";
MARIONETTE_TIMEOUT = 180000;

Cu.import("resource://gre/modules/Task.jsm");
const {Promise: promise} = Cu.import("resource://gre/modules/Promise.jsm", {});
let loader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);
let EventUtils = {};
loader.loadSubScript("chrome://marionette/content/EventUtils.js", EventUtils);

function openWebIDE() {
  let deferred = promise.defer();

  let win = Services.ww.openWindow(null, "chrome://webide/content/", "webide", "chrome,centerscreen,resizable", null);
  win.onload = function () {
    // Wait a tick, in order to let AppManager be available on `win`
    setTimeout(function () {
      deferred.resolve(win);
    });
  };

  return deferred.promise;
}

function connect(win) {
  // Create and register a fake runtime that will allow us to connect to an
  // arbitrary port
  let fakeRuntime = {
    type: "SIMULATOR",
    connect: function(connection) {
      is(connection, win.AppManager.connection, "connection is valid");
      connection.host = "localhost";
      connection.port = 6666;
      // Keep connecting as b2g desktop may still be initializing when we start trying to connect
      // XXX: This introduce manyyyyyyy error messages in the browser console,
      //      that would be great to ignore these errors??
      connection.keepConnecting = true;
      connection.connect();
      return promise.resolve();
    },

    get id() {
      return "fakeRuntime";
    },

    get name() {
      return "fakeRuntime";
    }
  };
  win.AppManager.runtimeList.simulator.push(fakeRuntime);
  win.AppManager.update("runtimelist");

  let panelNode = win.document.querySelector("#runtime-panel");
  let items = panelNode.querySelectorAll(".runtime-panel-item-simulator");

  let deferred = promise.defer();
  // XXX: Tweak app-manager.js to make it easier to know once it is ready!
  // Wait for full connection completion, once app-manager.js
  // fully setup its internal to the new runtime
  // (i.e. runtime apps can be listed)
  win.AppManager.on("app-manager-update", (_, name) => {
    if (name == "runtime-apps-found") {
      deferred.resolve();
    }
  });

  items[0].click();

  return deferred.promise;
}

function selectApp(win) {
  if (win.AppManager.selectedProject &&
      /*win.AppManager.selectedProject.type === "mainProcess"*/
      win.AppManager.selectedProject.name == "Clock") {
    return promise.resolve();
  }

  let deferred = promise.defer();

  let btn = win.document.querySelector("menuitem[command='cmd_showProjectPanel']");
  btn.click();
  setTimeout(function () {
    // let mainProcessNode = win.document.querySelector("#project-panel-runtimeapps > .panel-item[0]");

    let appNode = win.document.querySelector("#project-panel-runtimeapps > .panel-item[label=\"Clock\"]");
    appNode.click();

    // Wait for the app to be launched
    win.AppManager.on("app-manager-update", function onUpdate(event, what) {
      if (what == "project-is-running") {
        win.AppManager.off("app-manager-update", onUpdate);
        setTimeout(function () {
          deferred.resolve();
        });
      }
    });
  });

  return deferred.promise;
}

function openTool(toolbox, tool) {
  return toolbox.selectTool(tool);
}

function checkConsole(panel) {
  let deferred = promise.defer();

  //XXX: figure out why panel.panelWin doesn't exists
  // >> looks like WebConsolePanel just doesn't set it,
  //    even if it looks like some tests rely on it !!???
  let window = panel.hud.iframeWindow;
  let hud = panel.hud;

  hud.ui.on("new-messages", function (event, messages) {
    for (let msg of messages) {
      let elem = msg.node;
      let body = elem.querySelector(".message-body");
      if (body.textContent.contains("shell.html")) {
        ok(true, "Console works and we are evaluating within the main process");
        deferred.resolve();
      }
    }
  });

  // Simulate input in the console
  hud.jsterm.inputNode.focus();
  hud.jsterm.setInputValue("window.location.href");
  EventUtils.synthesizeKey("VK_RETURN", {}, window);

  return deferred.promise;
}

function checkInspector(inspector) {
  // Select the system app iframe
  let walker = inspector.walker;
  let updated = inspector.once("inspector-updated");
  walker.querySelector(walker.rootNode, "#systemapp")
        .then(nodeFront => {
          inspector.selection.setNodeFront(nodeFront, "test");
        });
  return updated.then(() => {
    is(inspector.selection.nodeFront.id, "systemapp", "Inspector works and is targetting the main process");
  });
}

var gTasks = 0;
function tryToFinish() {
  if (gTasks === 0) {
    finish();
  }
}

function ls(path) {
  let dir = new FileUtils.File(path);
  let results = [];

  let files = dir.directoryEntries;
  while (files.hasMoreElements()) {
    let file = files.getNext().QueryInterface(Ci.nsILocalFile);
    if (!file.isFile()) {
      continue;
    }
    results.push(file);
  }

  return results;
}

let success = [];
let REGEXP = /browser_inspector_((breadcrumbs_highlight_hover)|(breadcrumbs)|(delete-selected-node-.*)|(destroy-after-navigation)|(destroy-after-navigation))\.js/;
REGEXP = /(browser_inspector_breadcrumbs.js)|(browser_inspector_delete-selected-node-.*.js)|(browser_inspector_after-navigation.js)|(browser_inspector_highlight_after_transition.js)/;
function checkExistingTests(win) {
  let deferred = promise.defer();
  let path = "/mnt/desktop/gecko/browser/devtools/inspector/test/";
  let tests = ls(path).filter(file => file.leafName.match(REGEXP));
  function loop() {
    let file = tests.shift();
    if (!file) {
      console.log("!!!!END!!!!");
      console.log("success", success.join(", "));
      //deferred.resolve();
    } else {
      console.log("RUNNING", file.leafName);
      executeMochitest(win, file).then(loop);
    }
  }
  loop();

  return deferred.promise;
}

let TestActorFront;
function executeMochitest(win, test) {
  let deferred = promise.defer();

  let onDone = Task.async(function* () {
    // Ensure detroying the toolbox at the end of this test.
    yield win.UI.destroyToolbox();

    // Wait a tick or we end up with broken duplicated toolboxes
    setTimeout(deferred.resolve);
  });

  let tasks = 0;

  // Fake mochitest scope
  let scope = {
    gTestPath: "file://" + test.path,
    getRootDirectory: () => "file://" + test.parent.path + "/",
    waitForExplicitFinish: () => {},
    registerCleanupFunction: () => {},
    thisTestLeaksUncaughtRejectionsAndShouldBeFixed: () => {},

    // Forward all assertions to console until marionette display assertion
    // immediately and not only errors!
    is: (a, b, msg) => {
      console.log("is", a, b, msg);
      is(a, b, msg);
    },
    info: msg => {
      console.log("info", msg);
      ok(true, "info: " + msg);
    },
    ok: (a, msg) => {
      console.log("ok", a, msg);
      ok(a, msg)
    },

    add_task: func => {
      tasks++;
      Task.spawn(func)
          .then(() => {
            success.push(test.leafName);
            console.log("SUCCESS", test.leafName)
          }, e => {
            //alert("ex: "+e)
            console.error("task exception: ", String(e), e.stack);
          })
          .then(() => {
            if (--tasks == 0) {
              setTimeout(onDone, 100);
            }
          });
    }
  };

  try {
    // Load head.js
    let head = test.parent.clone();
    head.append("head.js");
    loader.loadSubScript("file://" + head.path, scope);

    // Overload some of the helper function from head.js
    scope.TEST_URL_ROOT = "file://" + test.parent.path + "/";

    scope.openInspectorForURL = function (url) {
      return this.openInspector(url);
    };

    scope.openInspector = function (url) {
      return Task.spawn(function* () {
        // Open an app in WebIDE
        yield selectApp(win);

        // Get a toolbox up and running
        let toolbox;
        if (!win.UI.toolboxPromise) {
          toolbox = yield win.UI.createToolbox();
        } else {
          toolbox = yield win.UI.toolboxPromise;
        }

        // Get an inspector up and running
        let inspector;
        if (toolbox.currentToolId == "inspector") {
          inspector = toolbox.getCurrentPanel();
        } else {
          inspector = yield openTool(toolbox, "inspector");
          yield inspector.once("inspector-updated");
        }

        // Navigate to a new document
        if (url) {
          console.log("navigate to", url);
          let activeTab = toolbox.target.activeTab;
          yield activeTab.navigateTo(url);

          // Wait for new-root first, before waiting for inspector-updated,
          // as we get noisy inspector-updated event*s* before new-root event,
          // that are fired early, while the inspector is still updating
          // to the new doc.
          yield inspector.once("new-root");
          yield inspector.once("inspector-updated");
        }

        let actor = yield scope.getTestActor(toolbox);
        return { inspector, toolbox, actor };
      });
    };

    // Ensure fetching a live TabActor form for the targeted app
    // (helps fetching the test actor registered dynamically)
    scope.getUpdatedForm = Task.async(function* () {
      let app = win.AppManager._getProjectFront(win.AppManager.selectedProject);
      return app.getForm(true);
    });

    // Evaluates the test script itself
    loader.loadSubScript("file://" + test.path, scope);

    // Register the test actor ASAP, as soon as we have access
    // to registerTestActor, so that the actor is registered early
    // and gets correctly created when opening a new app.
    scope.registerTestActor(win.AppManager.connection.client);

    // Test timeout:
    if (tasks == 0) {
      onDone();
    } else {
      setTimeout(function () {
        if (tasks > 0) {
          onDone();
        }
      }, 40000);
    }
  } catch(e) {
    alert("eval ex: "+e+"\n"+e.fileName+":"+e.lineNumber+"\n"+e.stack);
  }
  return deferred.promise;
}

Task.spawn(function () {
  let win = yield openWebIDE();
  yield connect(win);
  /*
  yield selectApp(win);
  let toolbox = yield win.UI.toolboxPromise;
  let console = yield openTool(toolbox, "webconsole");
  yield checkConsole(console);
  let inspector = yield openTool(toolbox, "inspector");
  yield checkInspector(inspector);
  */
  yield checkExistingTests(win);
  finish();
}).catch(e => {
  ok(false, "Exception: " + e);
  // XXX: We have to call finish in order to be able to see assertions!
  finish()
});
