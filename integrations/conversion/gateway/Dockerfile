FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
# The official binary carries cap_net_bind_service=ep. With cap_drop: ALL,
# Linux rejects exec of that privileged file. Only ports >1024 are used here.
USER root
RUN setcap -r /usr/bin/caddy && test -z "$(getcap /usr/bin/caddy)"
USER 1000:1000
