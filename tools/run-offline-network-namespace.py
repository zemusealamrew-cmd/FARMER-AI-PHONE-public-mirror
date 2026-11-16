"""Run a G1 diagnostic command in a Linux network namespace with loopback only.

Usage: python tools/run-offline-network-namespace.py receipt.json -- COMMAND ARGS
Does not change the host's adapters. Fails closed when isolation is unavailable.
"""
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def main():
    inside = len(sys.argv) > 1 and sys.argv[1] == '--inside'
    args = sys.argv[2:] if inside else sys.argv[1:]
    receipt = Path(args[0]).resolve()
    command = args[1:]
    if command and command[0] == '--':
        command = command[1:]
    if not command:
        raise SystemExit('A diagnostic command is required')
    if not inside:
        result = subprocess.run(['unshare', '--net', '--fork', sys.executable,
                                 str(Path(__file__).resolve()), '--inside', str(receipt), '--', *command])
        raise SystemExit(result.returncode)
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
    interfaces = json.loads(subprocess.check_output(['ip', '-j', 'link'], text=True))
    routes = json.loads(subprocess.check_output(['ip', '-j', 'route'], text=True))
    routes6 = json.loads(subprocess.check_output(['ip', '-6', '-j', 'route'], text=True))
    if any(link['ifname'] != 'lo' for link in interfaces) or routes or routes6:
        raise SystemExit('OFFLINE_NAMESPACE_NOT_LOOPBACK_ONLY')
    probes = []
    for family, address in [(socket.AF_INET, ('192.0.2.1', 9)),
                            (socket.AF_INET6, ('2001:db8::1', 9, 0, 0))]:
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(1)
            try:
                connection.connect(address)
            except OSError as error:
                if error.errno not in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EADDRNOTAVAIL):
                    raise
                probes.append({'family': family, 'errno': error.errno, 'result': 'NO_EXTERNAL_ROUTE'})
            else:
                raise SystemExit('OFFLINE_NAMESPACE_EGRESS_PROBE_FAILED')
    report = {'date': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'scope': 'entire diagnostic process tree in WSL/Linux namespace; host adapters unchanged',
              'interfaces': interfaces, 'routes': routes, 'ipv6_routes': routes6,
              'probes': probes, 'code': 'NETNS_LOOPBACK_ONLY_SELF_TESTED',
              'command': command, 'gates': 'G1 HOLD; G2/G3 NOT AUTHORIZED; G4 NO-GO'}
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps(report, indent=2) + '\n')
    os.environ['G1_NETNS_EVIDENCE'] = str(receipt)
    os.execvp(command[0], command)


if __name__ == '__main__':
    main()
