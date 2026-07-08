"""Proxima — Computer Module.
Unified interface for controlling the user's computer.
"""

from .core import Computer
from .element_resolver import ElementRef, ElementResolver

# Singleton — available to all agent code
computer = Computer()

__all__ = ["computer", "Computer", "ElementRef", "ElementResolver"]
