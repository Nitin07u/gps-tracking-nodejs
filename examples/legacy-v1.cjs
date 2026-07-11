/**
 * The gps-tracking v1 API, running unchanged on v2 through the compat layer.
 * This is the v1 README example. New code should use examples/simple.ts instead.
 */
var gps = require('../dist/index.cjs');

var options = {
  debug: true,
  port: 8090,
  device_adapter: 'TK103',
};

var server = gps.server(options, function (device, connection) {
  device.on('login_request', function (device_id, msg_parts) {
    // Accept the login request. You can set false to reject the device.
    this.login_authorized(true);
  });

  // PING -> When the gps sends their position
  device.on('ping', function (data) {
    console.log(data);
    return data;
  });
});

server.setDebug(true);
