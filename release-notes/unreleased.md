## Fixed

- Status, type, workspace summary, epic status, and molecule progress reads now pass both `--readonly` and `--sandbox` to bd to suppress auto-push, including on bd 1.1.0. Thanks to [Bart Wegrzyn (@bwegrzyn)](https://github.com/bwegrzyn) for diagnosing the status-refresh push race and contributing the initial fix in [#71](https://github.com/beadbox/beadbox/pull/71).
