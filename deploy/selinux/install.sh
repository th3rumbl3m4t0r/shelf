#!/bin/sh
# Builds and loads the shelf SELinux module and labels shelf's files. As root:
# deploy/selinux/install.sh
set -eu
cd "$(dirname "$0")"
make -f /usr/share/selinux/devel/Makefile shelf.pp
semodule -i shelf.pp
# a local rule, as file_contexts.homedirs would win over one in shelf.fc
semanage fcontext -l -C | grep -q '^/home/shelf(/\.\*)?' ||
    semanage fcontext -a -t shelf_data_t '/home/shelf(/.*)?'
restorecon -RF /opt/shelf/target/release /opt/shelf/deploy /opt/shelf/android/serve.py \
    /etc/shelf /srv/shelf-apk /home/shelf
