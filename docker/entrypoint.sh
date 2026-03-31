#!/bin/sh
# Keep the container alive by running a simple HTTP server on port 3000
# The Sandbox SDK checks this port to confirm the container is running
exec node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(3000, '0.0.0.0', () => {
  console.log('Sandbox ready on port 3000');
});
"
