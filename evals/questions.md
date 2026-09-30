# Eval questions

Each `##` section is one question: the heading is the question, each `- tool:`
line names a tool and its JSON arguments, each `- expect:` line a fact that must
appear in the tool result. Private tools are skipped unless the eval runs with
a token (not supported in v1: keep evals to public tools).

## What time is it in Ho Chi Minh City?

- tool: get_time {"timezone": "Asia/Ho_Chi_Minh"}
- expect: Asia/Ho_Chi_Minh

## What time is it in UTC?

- tool: get_time {"timezone": "UTC"}
- expect: UTC

## What happens with a bad timezone?

- tool: get_time {"timezone": "Mars/Olympus"}
- expect: Unknown timezone
