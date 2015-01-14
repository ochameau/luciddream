MARIONETTE_CONTEXT = "chrome";

const {Promise: promise} = Cu.import("resource://gre/modules/devtools/deprecated-sync-thenables.js", {});

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
  //is(items.length, 1, "Found one runtime button");

  let deferred = promise.defer();
  // XXX: Tweak app-manager.js to make it easier to know once it is ready!
  // Wait for full connection completion, once app-manager.js
  // fully setup its internal to the new runtime
  // (i.e. runtime apps can be listed)
  win.AppManager.on("app-manager-update", (_, name) => {
    if (name == "runtime-apps-found") {
      deferred.resolve(win);
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
    runtimeAppsNodes[0].click();
    setTimeout(function () {
    deferred.resolve(win);
    });
  });

  return deferred.promise;
}

function checkConsole(win) {
  win.UI.toolboxPromise.then(toolbox => {
    return toolbox.selectTool("webconsole").then(() => {
      let hud = toolbox.getCurrentPanel().hud;
      return {
        toolbox: toolbox,
        hud: hud
      };
    });
  })
  .then(({toolbox, hud}) => {
    return hud.jsterm.execute("window.location.href");
  }).then(msg => {
    ok(msg.textContent.contains("shell.html"), "Console works and we are evaluating within the main process");
  });
}

openWebIDE()
  .then(connect)
  .then(selectApp)
  .then(checkConsole)
  .then(finish);
