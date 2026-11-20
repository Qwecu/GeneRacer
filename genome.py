"""
Diploid car genome, modelled on TenderFace's genes.py.

Every car carries two chromosomes.  Each chromosome is a list of alleles,
and each allele is a (dominance, value) pair with both numbers in 0..255.
How the two alleles at a locus turn into a visible trait depends on the
expression mode the trait uses (see traits.py):

    dominant  - the allele with the higher dominance value wins (coin-flip-ish)
    avg       - additive: the mean of both alleles
    low       - the lower value always wins (one "weak" allele is enough)
    high      - the higher value always wins (one "strong" allele is enough)

Breeding works like TenderFace: each parent produces one gamete by
single-point crossover of its two chromosomes, and the child receives one
gamete from each parent.  Because crossover is single-point, genes that sit
next to each other on the chromosome tend to be inherited together
(genetic linkage).  On top of that, a small per-allele mutation rate keeps
new variation entering the population.
"""

import copy
import random

NUM_GENES = 41
MUTATION_RATE = 0.025      # chance per allele per breeding
MUTATION_STEP = 40         # max change of a mutated allele value


def _random_allele():
    return (random.randint(0, 255), random.randint(0, 255))


class CarGenome:

    def __init__(self, chromosome1=None, chromosome2=None, num_genes=NUM_GENES):
        self.num_genes = num_genes
        self.chromosome1 = chromosome1 or [_random_allele() for _ in range(num_genes)]
        self.chromosome2 = chromosome2 or [_random_allele() for _ in range(num_genes)]

    # -------------------------------------------------
    # EXPRESSION
    # -------------------------------------------------

    def _pair(self, index):
        if index < 0 or index >= self.num_genes:
            raise IndexError("Gene index out of range")
        return self.chromosome1[index], self.chromosome2[index]

    def dominant(self, index):
        (d1, v1), (d2, v2) = self._pair(index)
        return v1 if d1 >= d2 else v2

    def avg(self, index):
        (_, v1), (_, v2) = self._pair(index)
        return (v1 + v2) / 2

    def low(self, index):
        (_, v1), (_, v2) = self._pair(index)
        return min(v1, v2)

    def high(self, index):
        (_, v1), (_, v2) = self._pair(index)
        return max(v1, v2)

    def express(self, index, mode):
        """Return the expressed value at `index`, normalised to 0..1."""
        return getattr(self, mode)(index) / 255.0

    # -------------------------------------------------
    # BREEDING
    # -------------------------------------------------

    def _gamete(self):
        n = random.randint(0, self.num_genes - 1)
        if random.randint(0, 1) == 0:
            a, b = self.chromosome1, self.chromosome2
        else:
            a, b = self.chromosome2, self.chromosome1
        return list(a[:n]) + list(b[n:])

    @staticmethod
    def _mutate(chromosome):
        out = []
        for dom, val in chromosome:
            if random.random() < MUTATION_RATE:
                val = max(0, min(255, val + random.randint(-MUTATION_STEP, MUTATION_STEP)))
            if random.random() < MUTATION_RATE:
                dom = random.randint(0, 255)
            out.append((dom, val))
        return out

    @classmethod
    def make_child(cls, mother, father):
        m = cls._mutate(mother._gamete())
        f = cls._mutate(father._gamete())
        if random.randint(0, 1) == 0:
            m, f = f, m
        return cls(m, f, num_genes=mother.num_genes)

    # -------------------------------------------------
    # SERIALISATION
    # -------------------------------------------------

    def to_dict(self):
        return {
            "c1": [list(a) for a in self.chromosome1],
            "c2": [list(a) for a in self.chromosome2],
        }

    @classmethod
    def from_dict(cls, d):
        c1 = [tuple(a) for a in d["c1"]]
        c2 = [tuple(a) for a in d["c2"]]
        g = cls(c1, c2, num_genes=len(c1))
        # Genomes saved by an older version with fewer genes get padded.
        while g.num_genes < NUM_GENES:
            g.chromosome1.append(_random_allele())
            g.chromosome2.append(_random_allele())
            g.num_genes += 1
        return g

    def copy(self):
        return copy.deepcopy(self)
