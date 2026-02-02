#!/usr/bin/env bash

# Add your secrets with:
# security add-generic-password -a $USER -s "MY_API_TOKEN" -w "sk-secret-value-here"
# 
# 

TASKSCORE_AWS_ACCESS_KEY_ID=$(security find-generic-password -a $USER -s "TASKSCORE_AWS_ACCESS_KEY_ID" -w)
TASKSCORE_AWS_SECRET_ACCESS_KEY=$(security find-generic-password -a $USER -s "TASKSCORE_AWS_SECRET_ACCESS_KEY" -w)

cat <<EOF
export AWS_ACCESS_KEY_ID=$TASKSCORE_AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY=$TASKSCORE_AWS_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=ap-southeast-2
EOF

source $(dirname $0)/../.env
