MARIONETTE_CONTEXT = "chrome";

Cu.import("resource://gre/modules/Task.jsm");
const {Promise: promise} = Cu.import("resource://gre/modules/devtools/deprecated-sync-thenables.js", {});
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
  let deferred = promise.defer();

  let btn = win.document.querySelector("menuitem[command='cmd_showProjectPanel']");
  btn.click();
  setTimeout(function () {
    let runtimeAppsNodes = win.document.querySelectorAll("#project-panel-runtimeapps > .panel-item");
    // First runtime app is the main process
    // XXX: Add special class on it in order to be able to assert it
    runtimeAppsNodes[0].click();

    // Wait a tick in order to let onclick actions execute
    setTimeout(function () {
      deferred.resolve();
    });
  });

  return deferred.promise;
}

function openTool(toolbox, tool) {
  return toolbox.selectTool(tool)
                .then(() => toolbox.getCurrentPanel());
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

Task.spawn(function () {
  let win = yield openWebIDE();
  yield connect(win);
  yield selectApp(win);
  let toolbox = yield win.UI.toolboxPromise;
  let console = yield openTool(toolbox, "webconsole");
  yield checkConsole(console);
  let inspector = yield openTool(toolbox, "inspector");
  yield checkInspector(inspector);
  finish();
}).catch(e => {
  ok(false, "Exception: " + e);
  // XXX: We have to call finish in order to be able to see assertions!
  finish()
});
