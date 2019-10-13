var https = require('https');
var http = require('http');
var LRU = require('lru-cache');
var tls = require('tls');
var Buffer = require('safe-buffer').Buffer;
var util = require('../util');
var config = require('../config');
var http2 = config.enableH2 ? require('http2') : null;

var SUPPORTED_PROTOS = ['h2', 'http/1.1', 'http/1.0'];
var H2_SETTINGS = { enablePush: false , enableConnectProtocol: false };
var clients = {};
var notH2 = new LRU({max: 2560});
var pendingH2 = {};
var pendingList = {};
var TIMEOUT = 36000;

function getKey(options) {
  var proxyOpts = options._proxyOptions;
  var proxyType = '';
  if (proxyOpts) {
    proxyType = [proxyOpts.proxyType, proxyOpts.proxyHost, proxyOpts.proxyPort, proxyOpts.headers.host].join(':');
  }
  return [options.servername, options.host, options.port || '', proxyType].join('/');
}

function getSocksSocket(options, callback) {
  return callback(null, false);
}

function getTunnelSocket(options, callback) {
  var proxyOpts = options._proxyOptions;
  var request = proxyOpts.proxyType === 'https' ? https.request : http.request;
  var connOpts = {
    method: 'CONNECT',
    path: proxyOpts.headers.host,
    host: proxyOpts.proxyHost,
    port: proxyOpts.proxyPort,
    headers: proxyOpts.headers,
    servername: options.servername,
    agent: false
  };
  if (connOpts.proxyAuth) {
    connOpts.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(connOpts.proxyAuth).toString('base64');
  }
  var connReq;
  var timer = setTimeout(function() {
    if (timer) {
      timer = null;
      connReq.abort();
    }
  }, config.CONN_TIMEOUT);
  var handleCallback = function(err, socket) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      callback(err, socket);
    }
  };
  connReq = request(connOpts);
  connReq.once('connect', function(res, socket) {
    socket.on('error', util.noop);
    if (res.statusCode === 200) {
      handleCallback(null, socket);
    } else {
      var err = new Error('tunneling socket could not be established, ' + 'statusCode=' + res.statusCode);
      err.code = 'ECONNRESET';
      socket.destroy();
      handleCallback(err);
    }
  });
  connReq.on('error', handleCallback);
  connReq.end();
}

function getProxySocket(options, callback) {
  var handleConnect = function(err, socket) {
    if (err) {
      return callback(err);
    }
    var timer = setTimeout(function() {
      if (timer) {
        timer = null;
        socket.destroy();
      }
    }, config.CONN_TIMEOUT);
    var handleCallback = function(err) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        callback(err, err ? null : socket);
      }
    };
    socket = tls.connect({
      servername: options.servername,
      socket: socket,
      rejectUnauthorized: false,
      ALPNProtocols: SUPPORTED_PROTOS,
      NPNProtocols: SUPPORTED_PROTOS
    }, handleCallback);
    socket.on('error', handleCallback);
  };
  var proxyOpts = options._proxyOptions;
  proxyOpts.proxyType === 'socks' ?
    getSocksSocket(options, handleConnect) :
      getTunnelSocket(options, handleConnect);
}

function getSocket(options, callback) {
  if (!options) {
    return callback();
  }
  var handleCallback = function(err, socket) {
    if (err) {
      return callback(false, null, err);
    }
    var proto = socket.alpnProtocol || socket.npnProtocol;
    callback(proto === 'h2', socket);
  };
  options._proxyOptions ?
    getProxySocket(options, handleCallback) :
      util.connect({
        servername: options.servername,
        host: options.host,
        port: options.port || 443,
        rejectUnauthorized: false,
        ALPNProtocols: SUPPORTED_PROTOS,
        NPNProtocols: SUPPORTED_PROTOS
      }, handleCallback);
}

function getClient(req, socket, name) {
  var client = http2.connect('https://' + req.headers.host, {
    setttings: H2_SETTINGS,
    rejectUnauthorized: false,
    createConnection: function() {
      return socket;
    }
  });
  clients[name] = client;
  var handleClose = function() {
    delete clients[name];
    client.close();
    socket.destroy();
  };
  socket.on('error', handleClose);
  socket.on('close', handleClose);
  client.on('error', handleClose);
  return client;
}

function requestH2(client, req, res) {
  if (req.hasError) {
    return;
  }
  var headers = util.formatH2Headers(req.headers);
  delete req.headers.connection;
  delete req.headers['keep-alive'];
  delete req.headers['http2-settings'];
  delete req.headers['proxy-connection'];
  delete req.headers['transfer-encoding'];
  headers[':path'] = req.url;
  headers[':method'] = req.method;
  headers[':authority'] = req.headers.host;
  try {
    var h2Session = client.request(headers);
    h2Session.on('error', util.noop);
    h2Session.on('response', function(h2Headers) {
      var newHeaders = {};
      h2Session.statusCode = h2Headers[':status'];
      h2Session.httpVersion = '1.1';
      h2Session.headers = newHeaders;
      Object.keys(h2Headers).forEach(function(name) {
        if (name[0] !== ':') {
          newHeaders[name] = h2Headers[name];
        }
      });
      res.response(h2Session);
    });
    req.pipe(h2Session);
  } catch (e) {
    client.emit('error', e);
  }
}

exports.getServer = function(options, listener) {
  var createServer;
  if (options.allowHTTP1 && http2) {
    createServer = http2.createSecureServer;
    options.setttings = H2_SETTINGS;
  } else {
    createServer = https.createServer;
  }
  var server = createServer(options);
  if (typeof listener === 'function') {
    server.on('request', listener);
  } else if (listener) {
    Object.keys(listener).forEach(function(name) {
      server.on(name, listener[name]);
    });
  }
  return server;
};

function checkTlsError(err) {
  if (!err) {
    return true;
  }
  var code = err.code;
  if (typeof code !== 'string') {
    return false;
  }
  return code.indexOf('ERR_TLS_') === 0 || code.indexOf('ERR_SSL_') === 0;
}

/**
 * TODO(v2.0): 遗留两种需要处理的H2请求
 * 1. 设置代理后的请求
 * 2. 插件转发回来的请求
 */
exports.request = function(req, res, callback) {
  var options = req.useH2 && req.options;
  if (!options) {
    return callback();
  }
  var key = getKey(options);
  var name = req.sessionId + '\n' + key;
  var client = clients[name];
  if (client) {
    return requestH2(client, req, res);
  }
  var time = notH2.peek(key);
  if (time && (Date.now() - time < TIMEOUT || pendingH2[key])) {
    return callback();
  }
  pendingH2[key] = 1;
  var pendingItem = pendingList[name];
  if (pendingItem) {
    return pendingItem.push([req, res, callback]);
  }
  pendingItem = [[req, res, callback]];
  pendingList[name] = pendingItem;
  getSocket(options, function(isH2, socket, err) {
    client =isH2 && getClient(req, socket, name);
    delete pendingList[name];
    delete pendingH2[key];
    if (client) {
      notH2.del(key);
      pendingItem.forEach(function(list) {
        requestH2(client, list[0], list[1]);
      });
    } else {
      checkTlsError(err) && notH2.set(key, Date.now());
      pendingItem.forEach(function(list) {
        list[2](socket);
        socket = null;
      });
    }
  });
};