#!/usr/bin/env bash
# 

source $(dirname $0)/../.env
export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION

aws sesv2 send-email \
  --from-email-address "tushar.pokle@gmail.com" \
  --destination '{"ToAddresses":["tushar@me.com"]}' \
  --content '{
    "Simple": {
      "Subject": {"Data": "Test Subject", "Charset": "UTF-8"},
      "Body": {
        "Text": {"Data": "Hello, this is a test email.", "Charset": "UTF-8"}
      }
    }
  }'