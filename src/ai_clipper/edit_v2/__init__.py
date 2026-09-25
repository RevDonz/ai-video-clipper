"""Editor V3 Esensial: the single clip-edit-v2 resolver and compiler (plan §2.1 E1, Appendix A).

Everything in this package is standard-library Python. The contracts of every module are frozen
in ``docs/editor/CONTRACTS.md`` (plan Appendix A, §3, §4.2 and §4.3).
"""

COMPILER_VERSION = "edit-v2/1.0.0"  # semver of the compiler; part of every render key (R9)
COMPILER_ID = "edit-v2/1"  # the plan DTO field "compiler" and base.engine.compiler
RENDER_SEMANTICS = 1  # bump on any golden-pixel change (owner look approval)

__all__ = ["COMPILER_ID", "COMPILER_VERSION", "RENDER_SEMANTICS"]
