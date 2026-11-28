---
kind: Fixed
---
- **peers:** forgetting a computer now reaches that computer: its request to
  drop this one went without a JSON content type, which the forgery guard
  refused, so the other computer kept listing this one until removed by hand.
