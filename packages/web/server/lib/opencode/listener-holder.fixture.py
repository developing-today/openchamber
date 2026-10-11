# Stands in for systemd's socket unit for listener-handoff.test.js. It binds and listens on
# 127.0.0.1 and never calls accept(): systemd does not accept on its socket either, so a connection
# waits in the kernel's backlog until a service takes the socket. Each service is started with the
# socket as fd 3, and LISTEN_FDS/LISTEN_PID set the way systemd sets them.
#
# Protocol on stdin, one command per line: `start`, `stop`, `quit`. Replies on stdout:
# `port <n>` at startup, then `started <pid>` or `stopped <pid>`.
import os
import socket
import subprocess
import sys

fixture = sys.argv[1]

listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', 0))
listener.listen(128)
port = listener.getsockname()[1]
os.dup2(listener.fileno(), 3)
print(f'port {port}', flush=True)

service = None


def stop_service():
    global service
    if service is None:
        return None
    pid = service.pid
    service.terminate()
    service.wait()
    service = None
    return pid


for line in sys.stdin:
    command = line.strip()
    if command == 'start':
        service = subprocess.Popen(
            ['sh', '-c', 'export LISTEN_PID=$$ LISTEN_FDS=1; exec node "$1"', 'service', fixture],
            pass_fds=(3,),
            env={**os.environ, 'LISTENER_FIXTURE_PORT': str(port)},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f'started {service.pid}', flush=True)
    elif command == 'stop':
        print(f'stopped {stop_service()}', flush=True)
    elif command == 'quit':
        break

stop_service()
